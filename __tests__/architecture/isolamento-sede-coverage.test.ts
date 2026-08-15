import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK dell'isolamento fra sedi — per HANDLER, per SCRITTURA, su tabelle
 * lette dallo SCHEMA.
 *
 * ─── Perché è stato riscritto (2026-07-31) ───────────────────────────────────
 * La prima versione di questo lock (2026-07-30) è nata insieme all'audit che
 * chiudeva sette route: guardava il FILE, l'IMPORT e sette nomi di tabella. Il
 * giorno dopo, una ricognizione riga per riga ha trovato 140 rilievi — e questo
 * lock era VERDE su tutti. Non per un difetto di attuazione: per quattro difetti
 * di impianto, e ciascuno merita di essere ricordato perché è la ragione di una
 * regola qui sotto.
 *
 *  1. **Guardava il file, non l'handler.** `admin/students` importava lo scope
 *     per il suo GET; PATCH e DELETE, nello stesso file, non lo usavano affatto —
 *     e il lock vedeva un file «coperto». La granularità qui è l'EXPORT, come in
 *     `logging-coverage.test.ts`.
 *  2. **L'elenco delle tabelle era scritto a memoria**: sette nomi su 65 con
 *     `scuola_id`. `audit_scritture_docente`, `form_submissions`, `pagamenti`,
 *     `presenze`, `registro_orario` non erano guardati da nessuno. Ora l'elenco
 *     lo dice il database: `__tests__/fixtures/tabelle-scuola-id.json`.
 *  3. **Era cieco alle scritture.** Leggere righe di un'altra sede è una fuga;
 *     scriverci sopra è peggio, e nessuna regola lo controllava.
 *  4. **L'allowlist era per PREFISSO.** `parent/` esentava tutto ciò che
 *     cominciava per `parent/` — comprese le route che sarebbero nate dopo.
 *     Ora ogni voce è un `route:METODO` a match esatto.
 *
 * ─── Le regole ───────────────────────────────────────────────────────────────
 * Si controllano solo i file che usano il client SERVICE-ROLE: lì la RLS è
 * scavalcata per costruzione, quindi il gate applicativo è l'unico presidio.
 *
 *  • **ELENCHI** — una lettura che restituisce PIÙ righe da una tabella con
 *    `scuola_id` deve portare il filtro di sede NELLA STESSA QUERY. Non «da
 *    qualche parte nell'handler»: nella stessa query, perché è l'unico posto dove
 *    l'AND lo rende vero. È la forma esatta del difetto — una query senza filtro
 *    non fallisce, restituisce solo più righe del dovuto. Passa comunque
 *    l'elenco AGGANCIATO a un'identità che l'handler ha già verificato, o a id
 *    ricavati da una query precedente: mai a un id scelto dal client.
 *  • **SCRITTURE per riga** (`update`/`delete`) — la clausola di sede sta
 *    nell'istruzione che scrive, oppure la riga è stata verificata QUI con
 *    QUELLO stesso valore (gate sull'identità, o lettura per id della stessa
 *    tabella seguita dalla riscrittura). Un gate «da qualche parte
 *    nell'handler» non basta: si può spostare, duplicare o dimenticare in un
 *    ramo — la clausola no.
 *  • **SCRITTURE nuove** (`insert`/`upsert`) — non filtrano niente: la sede la
 *    DICHIARANO. O la risolve `resolveScuolaScrittura` (l'unico punto che
 *    risponde 400 quando è ambigua), o `scuola_id` compare fra i campi scritti.
 *    Un INSERT che di sede non parla affatto archivia nel plesso deciso dal
 *    default: è il modo silenzioso di scrivere nella sede sbagliata.
 *  • **TABELLE LEGATE ALL'ALUNNO** (`valutazioni`, `note_disciplinari`,
 *    `certificati_medici`, `pagelle`, …): non hanno `scuola_id` — la sede ce l'ha
 *    l'alunno. Lì il presidio non è un filtro sulla colonna ma il gate
 *    sull'identità (`assert*InScope`) o il legame di famiglia; si esige che
 *    l'handler ne abbia UNO.
 *  • **RPC** — una funzione di database gira in `SECURITY DEFINER` e non ha
 *    nessun filtro addosso: o riceve la sede fra i parametri (`p_scuola_id`), o
 *    agisce su una riga che l'handler ha già verificato.
 *
 * Che cos'è un GATE, per questo lock: una funzione che parla di sede e NEGA.
 * Non un elenco di nomi da tenere aggiornato a mano — si riconoscono dal CORPO
 * (`assert…InScope`, gli helper di file, quelli di `src/lib`), perché il repo ne
 * ha una decina scritti in casa e un lock che non li vede non è severo: chiede
 * di riscrivere codice corretto, e il primo che lo zittisce con un'allowlist ha
 * ragione lui.
 *
 * Chi non può rispettare le regole sta in `AMMESSE`, con la sua ragione scritta
 * per esteso. È volutamente prolisso: una riga di allowlist è una decisione, e
 * chi l'aggiunge deve poterla difendere.
 */

// ─────────────────────────────────────────────────────────────────────────────
// La fotografia dello schema
// ─────────────────────────────────────────────────────────────────────────────

type Fotografia = {
    generato_il: string
    sha256: string
    /** Tabelle di `public` che HANNO la colonna `scuola_id`. */
    con_scuola_id: string[]
    /** Tabelle senza `scuola_id` ma con `alunno_id`/`student_id`: la sede è dell'alunno. */
    legate_all_alunno: string[]
}

const FOTOGRAFIA = path.join(process.cwd(), '__tests__', 'fixtures', 'tabelle-scuola-id.json')

const COME_RIGENERARE =
    'Rigenera la fotografia: `node scripts/tabelle-sede-fotografia.mjs --sql` → esegui la query ' +
    'sul DB di produzione (sola lettura) → `node scripts/tabelle-sede-fotografia.mjs < risposta.json`.'

const foto: Fotografia = JSON.parse(fs.readFileSync(FOTOGRAFIA, 'utf8'))

/**
 * Tabelle sensibili SENZA `scuola_id` che la fotografia non può dedurre da sola,
 * perché non hanno nemmeno `alunno_id`. Sono tre, e ognuna ha una storia:
 */
const SENZA_COLONNA: Record<string, string> = {
    // Un genitore può avere figli in due sedi: `parents` non ha (e non deve avere)
    // una sede propria. Lo scope si deriva dai FIGLI — `assertParentInScope`.
    parents: 'sede derivata dai figli (assertParentInScope)',
    // Il ponte docente↔sezione: la sede è della SEZIONE. Senza gate qui si legge
    // e si scrive l'organico di un altro plesso.
    utenti_sezioni: 'sede della sezione (assertSezioneInScope)',
    // Un incasso appartiene al PAGAMENTO, che ha la sede: `assertPagamentoInScope`.
    incassi: 'sede del pagamento (assertPagamentoInScope)',
}

const CON_SEDE = new Set(foto.con_scuola_id)
const LEGATE_ALUNNO = new Set([...foto.legate_all_alunno, ...Object.keys(SENZA_COLONNA)])
const SENSIBILI = new Set([...CON_SEDE, ...LEGATE_ALUNNO])

// ─────────────────────────────────────────────────────────────────────────────
// Le forme che il lock riconosce
// ─────────────────────────────────────────────────────────────────────────────

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api')
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS'

/**
 * Il client che scavalca la RLS. Due forme, non una: chi rinomina l'import
 * (`import { createAdminClient as db }`) resta preso dalla seconda.
 */
const USA_SERVICE_ROLE = /createAdminClient\s*\(|SUPABASE_SERVICE_ROLE_KEY/

/**
 * ⚠️ QUESTA REGEX SI APPLICA AL CODICE, NON ALLA PROSA. Non è un dettaglio di
 * stile: fino al 2026-08-10 i due punti che la usano (`scopertureDelRepo` e il
 * test dei NUMERI) la passavano sul sorgente GREZZO, commenti compresi, e una
 * route ci finiva dentro per una parola scritta in una testata.
 *
 * MISURATO quel giorno, su tutte le 288 route di `src/app/api`: applicata al
 * sorgente grezzo la regex prende 280 file, applicata al codice ne prende 279, e
 * la differenza è UNA sola — `anagrafiche/comuni/route.ts`, che nomina
 * `createAdminClient()` in un commento per spiegare che è `rateLimit()` ad
 * aprirlo, e che non lo importa né lo chiama. Nessun altro file cambia lato:
 * questa correzione non allenta il lock di un millimetro, toglie un falso
 * positivo e basta.
 *
 * La difesa esisteva già ed era questo il solo punto del file che non la usava:
 * `mascheraSorgente` è nata (vedi la sua testata in `__tests__/fixtures/sorgente.ts`)
 * proprio perché in questo repo i commenti CITANO il codice che vietano — di
 * `.eq('scuola_id', …)` dentro un commento ce ne sono a decine, scritti apposta —
 * e ogni altro criterio di questo lock (`unitaDiQuery`, `rpcDi`, `helperDiScope`)
 * legge già `senzaCommenti`. Un lock che conta la prosa non misura il codice: fa
 * diventare rossa una riscrittura di un commento con un messaggio che parla di
 * service role, cioè manda chi indaga esattamente dalla parte sbagliata.
 */
function usaServiceRole(src: string): boolean {
    return USA_SERVICE_ROLE.test(mascheraSorgente(src).senzaCommenti)
}

/** `export const GET = withRoute(` — la granularità di questo lock. */
const EXPORT_HANDLER = new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\s*\\(`, 'g')

/** `.from('tabella')` — l'inizio di una query PostgREST. */
const DA_TABELLA = /\.from\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g

/**
 * Il filtro di sede, in tutte le forme in uso nel repo: colonna diretta
 * (`.in('scuola_id', …)`), colonna di una tabella incorporata
 * (`.in('alunni.scuola_id', …)`), sintassi PostgREST dentro `.or(…)`
 * (`scuola_id.in.(…)`), e `.match({ scuola_id })`.
 */
const FILTRO_SEDE =
    /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`](?:[A-Za-z_][\w]*\.)?scuola_id['"`]|['"`.]scuola_id\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\bscuola_id\b/

/**
 * I gate che verificano l'identità di un OGGETTO contro i plessi dell'utente:
 * `assertAlunnoInScope`, `assertSezioneInScope`, `assertPagamentoInScope`,
 * `assertAvvisoInScope`, … La forma del nome è il contratto (`assert…InScope`) e
 * vale anche per i gate locali di una route.
 */
const GATE_OGGETTO = /\bassert[A-Z][A-Za-z]*InScope\s*\(/

/** L'unico punto che risponde 400 quando la sede di una scrittura è ambigua. */
const SEDE_SCRITTURA = /\bresolveScuolaScrittura\s*\(/

/** `scuola_id: …` — la sede scritta esplicitamente in un oggetto da inserire. */
const SEDE_DICHIARATA = /\bscuola_id\s*:/

/** Le sedi su cui l'utente sta operando (letture). */
const SEDI_LETTURA = /\bresolveScuoleAttive\s*\(|\bscuoleDiUtente\s*\(/

const SCRITTURA_NUOVA = /\.(?:insert|upsert)\s*\(/
const SCRITTURA_RIGA = /\.(?:update|delete)\s*\(/
const UNA_RIGA = /\.(?:maybeSingle|single)\s*\(/

// ─────────────────────────────────────────────────────────────────────────────
// Il rilevatore
// ─────────────────────────────────────────────────────────────────────────────

export interface Handler {
    /** `GET`, `POST`, … oppure `<modulo>` per il codice fuori da ogni handler. */
    metodo: string
    da: number
    a: number
}

/** Gli handler HTTP di un file di route, come span sul sorgente. */
export function handlerDi(struttura: string): Handler[] {
    const out: Handler[] = []
    EXPORT_HANDLER.lastIndex = 0
    for (const m of struttura.matchAll(EXPORT_HANDLER)) {
        const aperta = m.index + m[0].length - 1
        out.push({ metodo: m[1], da: m.index, a: fineParentesi(struttura, aperta) })
    }
    return out
}

export interface Unita {
    tabella: string
    inizio: number
    /** Testo della catena + delle sue continuazioni condizionali. */
    testo: string
    scrittura: 'nuova' | 'riga' | null
    /** `.single()`/`.maybeSingle()`: una riga sola, per id. */
    singola: boolean
    /** I nomi a cui finisce il RISULTATO: `const { data: modello } = …` → `modello`. */
    risultati: string[]
}

/**
 * Le query di un sorgente, ciascuna con tutte le sue continuazioni.
 *
 * «Una query» è la catena che parte da `.from('…')` PIÙ le riassegnazioni
 * condizionali sulla stessa variabile (`let q = supabase.from('alunni')…` seguito
 * da `if (sede) q = q.in('scuola_id', plessi)`): PostgREST le combina in AND,
 * quindi sono la stessa query. È la forma con cui il repo scrive il degrado
 * `PGRST204/42703`, e senza questo il lock leggerebbe metà delle query del repo.
 */
export function unitaDiQuery(senzaCommenti: string, struttura: string): Unita[] {
    const unita: Unita[] = []
    DA_TABELLA.lastIndex = 0
    for (const m of senzaCommenti.matchAll(DA_TABELLA)) {
        // `supabase.storage.from('bucket')` non è una tabella.
        if (/\.storage\s*$/.test(senzaCommenti.slice(Math.max(0, m.index - 40), m.index))) continue
        const inizio = m.index
        const fine = fineCatena(struttura, inizio)
        const tratti = [{ a: inizio, b: fine }]

        // A quale variabile è assegnata la query? Serve per riattaccarle le
        // continuazioni condizionali.
        const prima = senzaCommenti.slice(Math.max(0, inizio - 200), inizio)
        const senzaRicevitore = prima.replace(/(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/, '')
        const variabile =
            /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
            /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
            null

        let usiSuccessivi = ''
        if (variabile) {
            const riassegna = new RegExp(`\\b${variabile}\\s*=`, 'g')
            riassegna.lastIndex = fine
            for (let r = riassegna.exec(senzaCommenti); r; r = riassegna.exec(senzaCommenti)) {
                const dopo = senzaCommenti.slice(r.index + r[0].length)
                const cont = new RegExp(`^\\s*(?:await\\s+)?${variabile}\\s*\\.`).exec(dopo)
                if (!cont) {
                    // La variabile viene RICOSTRUITA (`query = supabase.from(…)`,
                    // il ramo `if (role)` di mezzo mondo): da qui in poi le
                    // continuazioni appartengono alla query nuova. Ma quelle che
                    // seguono valgono anche per QUESTA, perché a runtime il
                    // filtro in coda si applica all'oggetto vivo, quale che sia
                    // il ramo preso. Non si esce: si continua a raccogliere.
                    if (!new RegExp(`^\\s*(?:await\\s+)?[A-Za-z_$][\\w$.]*\\s*\\.\\s*from\\s*\\(`).test(dopo)) break
                    continue
                }
                const punto = r.index + r[0].length + cont[0].length - 1
                tratti.push({ a: punto, b: fineCatena(struttura, punto) })
            }
            // `return q.maybeSingle()` non è una continuazione della query (non
            // aggiunge filtri) ma dice che la lettura è di UNA riga: senza
            // guardarlo, ogni `.maybeSingle()` scritto in coda a una variabile
            // verrebbe scambiato per un elenco.
            const usi = new RegExp(`\\b${variabile}\\s*\\.\\s*(?:maybeSingle|single)\\s*\\(`, 'g')
            usiSuccessivi = (senzaCommenti.slice(fine).match(usi) ?? []).join(' ')
        }

        // `const { data: modello, error } = await supabase.from(…)`: il nome a cui
        // finisce la riga letta. Serve per capire che «il gate ha verificato
        // `modello`» significa «ha verificato la riga con quell'id».
        const destrutturato = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*$/.exec(senzaRicevitore)?.[1]
        const risultati = destrutturato
            ? destrutturato.split(',').map((p) => (p.includes(':') ? p.split(':').pop() : p)!.trim())
                .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'error' && n !== 'count')
            : variabile ? [variabile] : []

        const testo = tratti.map((t) => senzaCommenti.slice(t.a, t.b)).join('\n')
        unita.push({
            tabella: m[1],
            inizio,
            testo,
            scrittura: SCRITTURA_NUOVA.test(testo) ? 'nuova' : SCRITTURA_RIGA.test(testo) ? 'riga' : null,
            singola: UNA_RIGA.test(testo) || UNA_RIGA.test(usiSuccessivi),
            risultati,
        })
    }
    return unita
}

export interface Scoperta {
    /** `GET`, `POST`, … o `<modulo>`. */
    handler: string
    riga: number
    tabella: string
    motivo:
    | 'elenco-senza-sede'
    | 'scrittura-senza-sede'
    | 'inserimento-senza-sede'
    | 'handler-senza-scope'
    | 'rpc-senza-sede'
}

/** Le chiamate `.rpc('nome'` del sorgente, con l'indice e gli argomenti. */
function rpcDi(senzaCommenti: string, struttura: string) {
    const out: { nome: string; inizio: number; args: string }[] = []
    const re = /\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]/g
    for (const m of senzaCommenti.matchAll(re)) {
        const aperta = senzaCommenti.indexOf('(', m.index)
        out.push({ nome: m[1], inizio: m.index, args: senzaCommenti.slice(m.index, fineParentesi(struttura, aperta)) })
    }
    return out
}

/** Il primo argomento è il client: non identifica niente. Né `auth.user`. */
const NON_IDENTITA = /^(?:supabase|admin|adminClient|db|client|auth\.user|user|request)$/

/**
 * Gli ESPRESSIONI che un gate `assert*InScope` ha verificato in questo span.
 *
 * `assertAlunnoInScope(supabase, auth.user, id)` non dice «l'utente vede
 * qualcosa»: dice «l'oggetto identificato da `id` è dentro i suoi plessi». La
 * differenza è tutta lì, e il lock la usa: una query agganciata a `id` è dentro
 * il perimetro, una agganciata a `bersagli.ids` — che quel gate non ha mai
 * guardato — non lo è. È la ragione per cui questo lock non si lascia
 * addomesticare mettendo un `assert…InScope` qualsiasi in cima all'handler.
 */
export function identitaVerificate(testoSpan: string, gate: RegExp = GATE_OGGETTO): string[] {
    const out: string[] = []
    for (const m of testoSpan.matchAll(new RegExp(gate.source, 'g'))) {
        // Argomenti fino alla parentesi che chiude la chiamata.
        let livello = 0
        let k = m.index + m[0].length - 1
        for (; k < testoSpan.length; k++) {
            if (testoSpan[k] === '(') livello++
            else if (testoSpan[k] === ')') { livello--; if (livello === 0) break }
        }
        const dentro = testoSpan.slice(m.index + m[0].length, k)
        // Split delle virgole di PRIMO livello (un argomento può essere un oggetto).
        const args: string[] = []
        let corrente = ''
        let prof = 0
        for (const c of dentro) {
            if ('([{'.includes(c)) prof++
            else if (')]}'.includes(c)) prof--
            if (c === ',' && prof === 0) { args.push(corrente); corrente = '' } else corrente += c
        }
        args.push(corrente)
        for (const a of args) {
            const espressione = a.replace(/\s+as\s+[\w[\]<>|'"\s]+$/, '').replace(/[!?]+$/, '').trim()
            if (!espressione || NON_IDENTITA.test(espressione)) continue
            if (!/^[A-Za-z_$][\w$.[\]']*$/.test(espressione)) continue
            out.push(espressione)
        }
    }
    return [...new Set(out)]
}

/**
 * La query è AGGANCIATA a un'identità già verificata? Cioè: uno dei suoi filtri
 * porta come VALORE una delle espressioni che un gate ha controllato.
 *
 * Vale per le letture d'elenco e per le scritture su riga: verificare l'alunno
 * `id` e poi scrivere `.eq('id', id)` è dentro il perimetro. Non vale per gli
 * INSERT (non filtrano niente) e non si accontenta del gate «da qualche parte»:
 * il gate deve aver guardato PROPRIO quel valore.
 */
export function ancorata(u: Unita, identita: string[]): boolean {
    return identita.some((v) => {
        const e = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`\\.(?:eq|in|filter|match)\\s*\\(\\s*['"\`][\\w.]+['"\`]\\s*,\\s*[^)]*(?<![\\w.])${e}\\b`).test(u.testo)
    })
}

/** Indice DOPO la graffa che chiude quella aperta in `apertura`. */
function fineGraffa(strut: string, apertura: number): number {
    let livello = 0
    for (let k = apertura; k < strut.length; k++) {
        if (strut[k] === '{') livello++
        else if (strut[k] === '}') { livello--; if (livello === 0) return k + 1 }
    }
    return strut.length
}

/**
 * Gli helper di FILE che fanno lo scope al posto dell'handler.
 *
 * Mezzo repo è scritto così: `caricaPostConScope(request, supabase, user, id)`,
 * `bersagliInScope(supabase, ids, plessi)`, `rigaNelleSedi(supabase, 'sections',
 * id, sedi)`. Sono gate a tutti gli effetti — solo con un nome di casa invece
 * che `assert…InScope`. Un lock che non li riconosce non sta essendo severo:
 * sta chiedendo di riscrivere codice corretto, e il primo che lo fa tacere con
 * un'allowlist ha ragione lui. Si riconoscono dal CORPO: una funzione che al suo
 * interno filtra per `scuola_id` o chiama un gate È un gate.
 */
export function helperDiScope(senzaCommenti: string, struttura: string, handler: Handler[] = []): string[] {
    const fuoriDaHandler = (i: number) => !handler.some((h) => i >= h.da && i < h.a)
    const nomi: string[] = []
    const dichiarazioni = [
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g,
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    ]
    for (const re of dichiarazioni) {
        for (const m of struttura.matchAll(re)) {
            if (!fuoriDaHandler(m.index)) continue
            const parametri = fineParentesi(struttura, m.index + m[0].length - 1)
            // La graffa del CORPO, non quella di un tipo di ritorno:
            // `): Promise<{ post?: NewsPost }> {` ne ha due, e la prima è il tipo.
            let graffa = -1
            let angolare = 0
            for (let k = parametri; k < struttura.length; k++) {
                const c = struttura[k]
                if (c === '<') angolare++
                else if (c === '>') angolare = Math.max(0, angolare - 1)
                else if (c === '{' && angolare === 0) { graffa = k; break }
            }
            if (graffa < 0) continue
            const corpo = senzaCommenti.slice(graffa, fineGraffa(struttura, graffa))
            // Un gate è una funzione che parla di sede E NEGA: o filtra
            // (`.in('scuola_id', …)`), o confronta (`sedi.includes(riga.scuola_id)`),
            // o chiama un altro gate, o risponde 403/404 ragionando sulla sede
            // (`esitoScopeModello`, che decide anche il caso «modello globale»).
            const nega = /\bscuola_id\b/.test(corpo) && /status:\s*(?:403|404)/.test(corpo)
            if (FILTRO_SEDE.test(corpo) || GATE_OGGETTO.test(corpo) || GATE_MANUALE.test(corpo) || nega) {
                nomi.push(m[1])
            }
        }
    }
    return [...new Set(nomi)]
}

/**
 * Gli stessi gate, ma quelli che vivono in `src/lib`: `esitoScopeModello`,
 * `staffScuola`, `sezioniDiUtente`… Si riconoscono allo stesso modo — dal corpo,
 * non dal nome — e si calcolano UNA volta per l'intera suite.
 */
export function gateDiLibreria(radice: string): string[] {
    const nomi: string[] = []
    for (const f of fileSorgente(radice)) {
        const { senzaCommenti, struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
        nomi.push(...helperDiScope(senzaCommenti, struttura))
    }
    return [...new Set(nomi)]
}

/** Da dove nasce un valore: dalla RICHIESTA (non fidato) o da una query fatta prima. */
const DA_RICHIESTA = /\bparse(?:Body|Query|Data)\s*\(|\.json\s*\(\s*\)|searchParams|await\s+params\b|\brawParams\b/
const DA_QUERY = /\bawait\b|\.(?:map|flatMap|filter|reduce|from)\s*\(|\bnew\s+Set\b/

/** I nomi legati da una dichiarazione: `const x =`, `const { a, b: c } =`. */
function nomiLegati(pattern: string): string[] {
    const p = pattern.trim()
    if (/^[A-Za-z_$][\w$]*$/.test(p)) return [p]
    const out: string[] = []
    for (const pezzo of p.replace(/^[{[]|[}\]]$/g, '').split(',')) {
        const nome = pezzo.includes(':') ? pezzo.split(':').pop() : pezzo
        const pulito = (nome ?? '').replace(/=.*$/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(pulito)) out.push(pulito)
    }
    return out
}

/**
 * Gli identificatori che vengono dalla RICHIESTA (body, query, parametri di
 * rotta), propagati di un paio di passaggi.
 *
 * Serve a distinguere due `.in('id', X)` che si somigliano e non hanno niente in
 * comune: `X` ricavato da una query già ristretta alla sede è dentro il
 * perimetro; `X` arrivato dal client è un IDOR con un altro nome — è
 * esattamente come la delibera delle ammissioni leggeva i candidati di un
 * modello altrui, passando `modelId` nel corpo della richiesta.
 */
export function identitaDallaRichiesta(testoSpan: string): Set<string> {
    const tainted = new Set<string>()
    const dichiarazioni: { nomi: string[]; rhs: string }[] = []
    const re = /(?:const|let|var)\s+((?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*))\s*(?::[^=]+?)?=\s*([^\n;]*)/g
    for (const m of testoSpan.matchAll(re)) dichiarazioni.push({ nomi: nomiLegati(m[1]), rhs: m[2] })
    for (let giro = 0; giro < 3; giro++) {
        for (const d of dichiarazioni) {
            const daAltro = [...tainted].some((t) => new RegExp(`(?<![\\w.])${t}\\b`).test(d.rhs))
            if (DA_RICHIESTA.test(d.rhs) || daAltro) d.nomi.forEach((n) => tainted.add(n))
        }
    }
    return tainted
}

/** `.eq('alunno_id', X)` / `.in('id', X)` — i filtri per identità della query. */
function filtriPerId(testo: string): string[] {
    const out: string[] = []
    for (const m of testo.matchAll(/\.(?:eq|in|filter|match)\s*\(\s*['"`]([\w.]+)['"`]\s*,\s*([^)]*)/g)) {
        const colonna = m[1].split('.').pop() ?? ''
        if (colonna !== 'id' && !colonna.endsWith('_id')) continue
        const base = /^[A-Za-z_$][\w$]*/.exec(m[2].trim())?.[0]
        if (base) out.push(base)
    }
    return out
}

/**
 * L'elenco è agganciato a identificatori RICAVATI da una query precedente
 * dell'handler — e non arrivati dalla richiesta.
 *
 * È il secondo giro di una lettura in due tempi («prendi gli alunni della sede,
 * poi le loro presenze»): la restrizione di sede sta nel PRIMO giro, che questo
 * stesso lock controlla. Se il primo giro non filtra, è lui a diventare rosso —
 * quindi la catena regge. Ciò che non regge, e resta rosso, è agganciare
 * l'elenco a un id che ha scelto il client.
 */
export function chiaveDerivata(u: Unita, richiesta: Set<string>, assegnate: Map<string, string>): boolean {
    const chiavi = filtriPerId(u.testo)
    if (chiavi.length === 0) return false
    return chiavi.some((v) => !richiesta.has(v) && DA_QUERY.test(assegnate.get(v) ?? ''))
}

/**
 * Le espressioni da cui ogni identificatore prende il suo valore, in uno span.
 *
 * Non bastano le dichiarazioni: nel repo una lista si costruisce spesso in due
 * tempi (`let sezioni = []` … `sezioni = data ?? []`), e si consuma dentro un
 * `.map()` o un `for…of`, dove il nome nuovo è un PARAMETRO e non
 * un'assegnazione. Se il lock non segue anche quelli, ogni `.eq('section_id',
 * s.id)` dentro un ciclo gli sembra una chiave uscita dal nulla.
 */
export function assegnazioni(testoSpan: string): Map<string, string> {
    const out = new Map<string, string>()
    const aggiungi = (n: string, rhs: string) => out.set(n, (out.get(n) ?? '') + ' ' + rhs)
    const dichiarazione = /(?:const|let|var)\s+((?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*))\s*(?::[^=]+?)?=\s*([^\n;]*)/g
    for (const m of testoSpan.matchAll(dichiarazione)) for (const n of nomiLegati(m[1])) aggiungi(n, m[2])
    // Riassegnazione senza dichiarazione: `sezioni = (data ?? [])`.
    const riassegnazione = /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*([^\n;=][^\n;]*)/g
    for (const m of testoSpan.matchAll(riassegnazione)) aggiungi(m[1], m[2])
    // `for (const s of sezioni)` e `sezioni.map((s) => …)`: `s` vale quello che
    // vale la lista da cui esce.
    const ciclo = /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)/g
    for (const m of testoSpan.matchAll(ciclo)) aggiungi(m[1], m[2])
    const callback = /([A-Za-z_$][\w$.?]*)\s*\.\s*(?:map|forEach|filter|flatMap|find|some|every|reduce)\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g
    for (const m of testoSpan.matchAll(callback)) aggiungi(m[2], m[1] + ' ' + (out.get(m[1].split('.')[0]) ?? ''))
    return out
}

/**
 * Il gate di sede scritto A MANO: si legge la riga, si confronta la sua
 * `scuola_id` con le sedi accessibili e si risponde 404. È la forma che usano le
 * route contabili, ed è un presidio vero — solo scritto in casa invece che con
 * `assert*InScope`. Vale come gate per le operazioni AGGANCIATE a un id (la riga
 * appena letta e verificata); non vale, e non deve valere, per un elenco che
 * quella verifica non l'ha mai attraversata.
 */
const GATE_MANUALE = /\.(?:includes|has)\s*\([^)]*\bscuola_id\b/

/**
 * Tutto quello che, in un file di route, tocca una tabella sensibile senza
 * dichiarare la sede. Il risultato è ordinato per posizione nel file.
 */
export function scoperte(src: string): Scoperta[] {
    const { senzaCommenti, struttura } = mascheraSorgente(src)
    const handler = handlerDi(struttura)
    const unita = unitaDiQuery(senzaCommenti, struttura).filter((u) => SENSIBILI.has(u.tabella))
    const fuori: Scoperta[] = []

    /** Il metodo dello span a cui appartiene un indice. */
    const spanDi = (i: number): string => handler.find((h) => i >= h.da && i < h.a)?.metodo ?? '<modulo>'

    // Il codice fuori da ogni handler (helper di file, costanti) è uno span a sé:
    // ci vivono i risolutori di sede riusati dai vari rami, e vanno controllati
    // come tutto il resto. Il suo «testo» è il file con gli handler spenti: la
    // sede risolta dentro un GET non copre un helper che sta fuori.
    const spans: Handler[] = [...handler, { metodo: '<modulo>', da: 0, a: src.length }]
    const testoModulo = [...senzaCommenti]
        .map((c, i) => (handler.some((h) => i >= h.da && i < h.a) ? ' ' : c))
        .join('')

    // Gli helper di file che fanno lo scope contano come gate, e le identità che
    // verificano sono gli argomenti con cui vengono chiamati.
    const helper = [...GATE_LIB, ...helperDiScope(senzaCommenti, struttura, handler)]
    const GATE = helper.length > 0
        ? new RegExp(`${GATE_OGGETTO.source}|\\b(?:${helper.join('|')})\\s*\\(`)
        : GATE_OGGETTO

    for (const s of spans) {
        const sue = unita.filter((u) => spanDi(u.inizio) === s.metodo)
        const rpc = rpcDi(senzaCommenti, struttura).filter((r) => spanDi(r.inizio) === s.metodo)
        if (sue.length === 0 && rpc.length === 0) continue

        const testoSpan = s.metodo === '<modulo>' ? testoModulo : senzaCommenti.slice(s.da, s.a)
        const identita = identitaVerificate(testoSpan, GATE)
        // Transitività: se il gate ha verificato `modello`, e `modello` è la riga
        // letta da `.from('form_models').eq('id', id)`, allora è `id` a essere
        // verificato — ed è con `id` che l'handler scriverà.
        for (const u of sue) {
            if (u.risultati.some((r) => identita.includes(r))) identita.push(...filtriPerId(u.testo))
        }
        const gateOggetto = identita.length > 0
        const sedeScrittura = SEDE_SCRITTURA.test(testoSpan)
        const richiesta = identitaDallaRichiesta(testoSpan)
        const assegnate = assegnazioni(testoSpan)
        const gateManuale = GATE_MANUALE.test(testoSpan)

        // «Leggi la riga per id, verifica, riscrivila»: l'idioma di mezzo repo.
        // Se l'handler ha un gate E ha letto QUELLA riga di QUELLA tabella con
        // QUELLA chiave, la scrittura che segue è dentro il perimetro. Se la
        // chiave della scrittura è un'altra — un elenco di id arrivati dal corpo
        // della richiesta, per dire — non lo è, e resta rossa.
        const lettePerChiave = new Map<string, Set<string>>()
        for (const u of sue) {
            if (u.scrittura || !u.singola) continue
            const set = lettePerChiave.get(u.tabella) ?? new Set<string>()
            filtriPerId(u.testo).forEach((k) => set.add(k))
            lettePerChiave.set(u.tabella, set)
        }

        /**
         * SCRITTURE — la riga su cui si scrive è stata verificata QUI, con QUESTO
         * valore. Due sole forme, e nessuna delle due è «il gate sta da qualche
         * parte nell'handler»: o il gate ha guardato proprio quell'espressione
         * (`ancorata`), o l'handler ha letto quella riga di quella tabella con
         * quella chiave e poi la riscrive.
         *
         * Di proposito NON vale qui `chiaveDerivata`: «gli id vengono da una
         * query che filtrava» è un ragionamento sulla PROVENIENZA, e la
         * provenienza cambia quando qualcuno tocca la query di sopra. Per le
         * letture è un compromesso accettabile — al massimo si legge di troppo;
         * per una scrittura no.
         */
        const suRigaVerificata = (u: Unita) =>
            ancorata(u, identita) ||
            ((gateOggetto || gateManuale) &&
                filtriPerId(u.testo).some((k) => lettePerChiave.get(u.tabella)?.has(k)))

        /**
         * Per le LETTURE d'elenco basta meno: l'handler ha un gate e l'elenco è
         * agganciato a un id che NON arriva dalla richiesta. È il secondo giro di
         * una lettura in due tempi dentro un handler che un'identità l'ha
         * verificata. Il limite è dichiarato: il gate può aver verificato un
         * oggetto e l'elenco pescare da un altro id — per questo la forma
         * preferita resta `ancorata()`, che pretende lo STESSO valore. Ciò che
         * non passa mai, e non deve, è l'elenco agganciato a un id scelto dal
         * client: quello è un IDOR, gate o non gate.
         */
        const elencoAgganciato = (u: Unita) =>
            (gateOggetto || gateManuale) && filtriPerId(u.testo).some((k) => !richiesta.has(k))

        // ── Regole per query ────────────────────────────────────────────────
        const perQuery: Scoperta[] = []
        const segnala = (i: number, tabella: string, motivo: Scoperta['motivo']) =>
            perQuery.push({ handler: s.metodo, riga: riga(src, i), tabella, motivo })

        /**
         * Il filtro di sede può arrivare in una VARIABILE:
         * `const filtroSede = \`scuola_id.is.null,scuola_id.in.(…)\`` e poi
         * `.or(filtroSede)`. È un filtro a tutti gli effetti, e non vederlo
         * significherebbe chiedere di riscrivere una query corretta.
         */
        const sedeIndiretta = (u: Unita) => {
            for (const m of u.testo.matchAll(/\.(?:or|filter)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
                if (/scuola_id/.test(assegnate.get(m[1]) ?? '')) return true
            }
            return false
        }

        for (const u of sue) {
            const conSede = FILTRO_SEDE.test(u.testo) || sedeIndiretta(u)
            if (u.scrittura === 'nuova') {
                // Un INSERT non filtra: DICHIARA. O la sede la risolve
                // `resolveScuolaScrittura` (l'unico punto che nega quando è
                // ambigua), o compare esplicitamente fra i campi scritti —
                // derivata dall'oggetto (`scuola_id: alunno.scuola_id`) o dal
                // client. Quello che non si accetta è l'INSERT che di sede non
                // parla affatto: quella riga finisce nel plesso che decide il
                // default, ed è il modo silenzioso di archiviare nella sede
                // sbagliata.
                // La riga scritta può essere costruita in una variabile qualche
                // riga più su (`const rows = […].map(p => ({ scuola_id: … }))`):
                // la sede si cerca in tutto l'handler, non solo nella catena.
                if (CON_SEDE.has(u.tabella) && !sedeScrittura && !conSede && !SEDE_DICHIARATA.test(testoSpan)) {
                    segnala(u.inizio, u.tabella, 'inserimento-senza-sede')
                }
            } else if (u.scrittura === 'riga') {
                if (!conSede && CON_SEDE.has(u.tabella) && !suRigaVerificata(u)) {
                    segnala(u.inizio, u.tabella, 'scrittura-senza-sede')
                }
            } else if (
                !u.singola && !conSede && CON_SEDE.has(u.tabella) &&
                !suRigaVerificata(u) && !elencoAgganciato(u) &&
                !chiaveDerivata(u, richiesta, assegnate)
            ) {
                // Lettura di ELENCO: è la forma che restituisce silenziosamente
                // le righe di un'altra sede. La lettura di UNA riga per id resta
                // coperta dalla regola d'insieme (il gate sull'oggetto).
                segnala(u.inizio, u.tabella, 'elenco-senza-sede')
            }
        }
        for (const r of rpc) {
            // Una funzione di database gira in SECURITY DEFINER: nessun filtro le
            // arriva addosso. O riceve la sede fra i parametri (`p_scuola`,
            // `p_scuola_id`), o agisce su una riga che l'handler ha già
            // verificato — `ricalcola_stato_pagamento({ p_id: id })` dopo
            // `assertPagamentoInScope(…, id)`.
            const conSedeArg = /scuola/i.test(r.args)
            const suOggettoVerificato =
                identita.some((v) => new RegExp(`(?<![\\w.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(r.args)) ||
                (gateManuale && /\bp_[a-z_]*id\b/.test(r.args))
            if (!conSedeArg && !suOggettoVerificato && !sedeScrittura) {
                segnala(r.inizio, `rpc:${r.nome}`, 'rpc-senza-sede')
            }
        }

        // ── Regola d'insieme: l'handler deve avere ALMENO un presidio ────────
        // Vale soprattutto per le tabelle legate all'ALUNNO, che una colonna
        // `scuola_id` non ce l'hanno: lì il filtro non esiste, esiste il gate.
        // Si emette solo se le regole per query non hanno già detto la stessa
        // cosa in modo più preciso: un lock che segnala due volte lo stesso
        // difetto è un lock che si legge male.
        const haScope =
            sue.some((u) => FILTRO_SEDE.test(u.testo)) || gateOggetto || gateManuale ||
            sedeScrittura || SEDI_LETTURA.test(testoSpan)
        if (!haScope && sue.length > 0 && perQuery.length === 0) {
            segnala(sue[0].inizio, sue[0].tabella, 'handler-senza-scope')
        }
        fuori.push(...perQuery)
    }

    return fuori.sort((a, b) => a.riga - b.riga || a.motivo.localeCompare(b.motivo))
}

// ─────────────────────────────────────────────────────────────────────────────
// I file da controllare
// ─────────────────────────────────────────────────────────────────────────────

function routeFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) out.push(...routeFiles(full))
        else if (e.name === 'route.ts') out.push(full)
    }
    return out
}

/** `src/app/api/admin/parents/[id]/route.ts` → `admin/parents/[id]` */
function nomeRoute(file: string): string {
    return path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/')
}

const FILES = routeFiles(API_ROOT)

/** I gate di `src/lib`: si calcolano una volta sola per tutta la suite. */
const GATE_LIB = gateDiLibreria(path.join(process.cwd(), 'src', 'lib'))


// ─────────────────────────────────────────────────────────────────────────────
// L'ALLOWLIST — a MATCH ESATTO, `<route>:<METODO>`
//
// La versione precedente esentava per PREFISSO: `parent/` copriva tutto ciò che
// cominciava per `parent/`, comprese le route che sarebbero nate dopo. Qui una
// voce vale per UN handler e basta: un `POST` nuovo accanto a un `GET` esentato
// non eredita niente. `<modulo>` è il codice fuori da ogni handler (gli helper
// di file), che ha le stesse regole di tutti.
//
// Ogni riga è una decisione, non un'eccezione di comodo. Chi ne aggiunge una
// deve poterla difendere davanti a un genitore: sono dati di minori.
// ─────────────────────────────────────────────────────────────────────────────
const AMMESSE: Record<string, string> = {
    // ── Scope FAMIGLIA: il genitore vede i propri figli, ovunque siano iscritti ──
    // Non è la sede a delimitare, è il legame genitore↔figlio (`requireParent`,
    // `genitoreHasFiglio`). Un filtro di sede qui sarebbe perfino SBAGLIATO: due
    // fratelli possono stare in due plessi.
    //
    // ⚠️ QUESTO BLOCCO ERA IL DOPPIO DI COSÌ, e undici delle sue voci dicevano una
    // cosa non vera (2026-07-31). «Scope famiglia» descriveva le venti route che
    // passano da `requireParentOfStudent`, ma quel gate verificava il legame SOLO
    // a chi era `genitore`: ogni altro ruolo passava, su un client service-role
    // che scavalca la RLS. Misurato in produzione: un educator di Aversa leggeva
    // il diario e le assenze — con la giustificazione, che è testo sanitario — di
    // un minore di Giugliano; la cuoca pure. La riga di allowlist non copriva uno
    // scope di famiglia: copriva l'assenza di qualunque scope per chiunque non
    // fosse un genitore, e mentre lo faceva SPEGNEVA IL SOSPETTO — che è il danno
    // peggiore di una voce falsa, perché una route non coperta prima o poi si
    // trova, una coperta a torto no.
    //
    // Le voci non sono state riscritte meglio: sono state TOLTE, perché il debito
    // è stato pagato. `requireParentOfStudent` ora chiama `assertAlunnoInScope`
    // per tutti i ruoli diversi da `genitore`, quindi è un gate a tutti gli
    // effetti — e questo lock lo riconosce da solo, dal CORPO (regola qui sopra:
    // «una funzione che parla di sede e nega È un gate»). Nessuna esenzione
    // serve più a: parent/presenze:GET, parent/presenze/giustifica:POST,
    // parent/competenze:GET, parent/giustifiche-didattiche:POST,
    // parent/primaria/{assenze,note,orario,pagella,scrutinio}:GET,
    // parent/primaria/pagella/firma:POST, diary/checkin:GET,
    // locker/inventory:{GET,POST}.
    'parent/students:GET': 'scope famiglia: i figli del richiedente, in qualunque plesso',
    // `parent/presenze/comunica-assenza:POST` NON è più qui (2026-08-07), e il
    // debito è stato pagato davvero: l'upsert dichiara `scuola_id`, letto da
    // `alunni` — la stessa fonte che usa il trigger `trg_presenze_scuola_id`.
    // La voce diceva «l'attore è verificato, la riga nasce senza plesso», ed era
    // esatta: chi scriveva lo si sapeva, DOVE finiva la riga no. Restava appesa a
    // un trigger che il DB E2E della CI non ha, perché non è migrato — cioè in
    // CI la riga nasceva senza plesso per davvero.
    'parent/submissions:GET': 'scope famiglia: moduli compilati per i propri figli',
    'parent/medical-certificates:GET': 'scope famiglia: certificati medici dei propri figli',
    'parent/medical-certificates:POST': 'scope famiglia: caricamento su un proprio figlio',
    'parent/forms/otp:PATCH': 'scope famiglia + OTP monouso sulla propria compilazione',
    'parent/primaria:GET': 'scope famiglia: registro del proprio figlio',
    'parent/primaria/note/firma:POST': 'scope famiglia: firma sulla nota del proprio figlio',
    // L'account è del genitore: lo scope è SE STESSO, non una sede.
    'parent/account/richiesta-cancellazione:GET': 'self: la richiesta di cancellazione del proprio account',
    'parent/account/richiesta-cancellazione:DELETE': 'self: revoca della propria richiesta',
    'parent/account/richiesta-cancellazione:<modulo>': 'self: helper che risolve il `parents.id` del richiedente',
    'me:GET': "self: identità dell'utente corrente",
    // Gate per LEGAME genitore↔figlio, fuori dall area `parent/`.
    'notes/sign:POST': 'legame genitore↔figlio (genitoreHasFiglio) sulla nota da firmare',
    'locker/notify:POST': 'legame genitore↔figlio: avviso armadietto al genitore del bambino',
    // `segnalazioni:<modulo>` NON è più qui (2026-08-03). Diceva «legame
    // genitore↔figlio + self sulla propria segnalazione», e per i genitori era
    // vero; per tutti gli altri non c'era NIENTE — `verificaAccesso` leggeva
    // `galleria_media_v2` e `eventi_diario` senza nessun filtro di sede, e la
    // riga di allowlist copriva quel vuoto mentre lo faceva sembrare una scelta.
    // Ora il modulo risolve le sedi del segnalante (`scuoleDiUtente`, o i plessi
    // dei figli per il genitore) e filtra `.in('scuola_id', sedi)` nella stessa
    // query.
    //
    // ⚠️ MA QUESTO LOCK QUEI TRE FILTRI NON LI VEDE, e la riga precedente diceva
    // il contrario («il lock lo riconosce da solo»). MISURATO il 2026-08-03:
    // togliendo tutti e tre i `.in('scuola_id', sedi)` dalla route, questo file
    // resta 20/20 VERDE. Il motivo sta nelle regole scritte in cima: le letture
    // di `galleria_media_v2` e `eventi_diario` sono `.eq('id', …).maybeSingle()`,
    // cioè UNA RIGA, e la regola per query sugli elenchi non le guarda; la
    // lettura d'elenco su `alunni` è agganciata a `figli`, che viene da una query
    // precedente (`chiaveDerivata`). L'unica regola che arriva fin qui è quella
    // d'insieme, e le basta che il modulo NOMINI uno scope: `scuoleDiUtente`
    // dentro `sediDelSegnalante` la soddisfa. Infatti — misurato lo stesso
    // giorno — togliendo ANCHE quella chiamata il lock diventa rosso, con
    // `handler-senza-scope su alunni`. Cioè: qui il lock certifica che una sede
    // si calcola, non che la si usi come filtro.
    //
    // L'esenzione resta tolta perché il debito è pagato davvero, non perché
    // questo lock lo dimostri. A dimostrarlo sono i test di comportamento —
    // `__tests__/api/segnalazioni-scope-sede.test.ts`, che con un finto client
    // che i filtri li APPLICA diventa rosso (3 casi) appena si toglie il filtro
    // sui media. Chi legge questa riga e sta per fidarsi del lock su una route
    // «coperta» faccia la stessa prova: tolga il presidio e guardi se qualcosa
    // diventa rosso. È l'unica misura che vale.

    // ── Scope CONVERSAZIONE: si accede solo ai thread di cui si è partecipanti ──
    // `chat_threads` porta `teacher_id`/`parent_id`: il gate è l'appartenenza,
    // verificata riga per riga. Una conversazione di un altro plesso non è
    // raggiungibile perché non se ne è partecipanti, non perché filtrata.
    'chat/threads:GET': 'scope conversazione: solo i thread di cui si è teacher o parent',
    'chat/messages:GET': 'scope conversazione: partecipazione verificata sul thread (404/403)',
    'chat/messages:POST': 'scope conversazione: partecipazione verificata prima di scrivere',
    'chat/messages/read:PATCH': 'scope conversazione: si segnano letti solo i propri thread',
    'chat/threads/[id]/riapri:POST': 'scope conversazione: solo i partecipanti del thread',
    'chat/contacts:GET': 'rubrica: docenti/genitori con cui si PUÒ aprire un thread, derivati dalle proprie sezioni',
    'educator-sections:<modulo>': 'ricostruisce le sezioni del docente dai media che ha caricato lui (fallback storico)',

    // ── Job schedulati: nessun utente, iterano per sede ──────────────────────
    'notifiche/promemoria:POST': 'cron: itera per sede, nessun utente da cui derivare uno scope',
    'news/cron/run:<modulo>': 'cron: digest per sede, iterazione esplicita su `sediReali`',
    'pagamenti/solleciti/run:POST': "cron dei solleciti: gira su tutte le sedi e ogni sollecito nasce con la sede del pagamento; l'invocazione è protetta dal segreto del cron, non da un utente",
    'mensa/allergie-check:POST': "due rami: cron globale (segreto del cron, itera su tutte le sedi) e chiamata di staff (requireStaff, sede dell'alunno controllato)",

    // ── Sigillati in produzione da sealDangerous() → 404 ─────────────────────
    // Non girano mai fuori dallo sviluppo. (`admin/seed-full` e `seed-db` NON
    // sono più qui: cancellate il 2026-07-31 perché cablavano l uuid di una sede
    // e `.env.local` punta al database di PRODUZIONE — il sigillo guarda
    // NODE_ENV, non il database.)
    'admin/wipe:POST': 'sealDangerous: 404 in produzione',
    'admin/check-schema:GET': 'sealDangerous',
    'admin/test-relations:GET': 'sealDangerous',
    'admin/setup-registro:GET': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/debug-mensa-auth:GET': 'sealDangerous',
    'admin/apply-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-fase4-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-forms-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-mensa-multi-menu-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'debug/scrutini:GET': 'sealDangerous',

    // ── Flussi pubblici: il gate è un token, non una sessione ────────────────
    'public/forms/[token]/submit:POST': 'token pubblico del modello: la sede è quella del modello',
    'public/forms/[token]/upload:POST': 'token pubblico del modello',
    'iscrizione:<modulo>': 'modulo pubblico: la sede è scelta nel wizard e validata dentro la route',
    'iscrizione/model:GET': 'modulo pubblico: legge il modello di iscrizione, che è globale',
    // ── `iscrizione/insegnanti:POST` NON È QUI, ed è una decisione misurata ───
    //
    // È l'INSERT pubblico del modulo «Lavora con noi»: un anonimo scrive una riga
    // in `candidature_insegnanti`, che è una tabella CON `scuola_id` (fotografia
    // del 2026-08-10). Sembra il caso da esentare — non c'è nessun utente da cui
    // derivare uno scope — e invece l'esenzione non serve, perché il debito non
    // esiste: l'INSERT la sede la DICHIARA (`scuola_id: scuolaId`), e quel valore
    // non arriva crudo dal client — è accettato solo se compare fra le sedi note
    // lette da `sediReali`, senza nessun default silenzioso. Con tre plessi, una
    // route che «indovina» archivia la candidatura nel plesso sbagliato e la
    // segreteria che l'aspetta crede che non sia mai arrivata.
    //
    // Una voce qui sarebbe una voce MORTA (il test «l'allowlist non contiene voci
    // morte» la respingerebbe), e sarebbe peggio che inutile: spegnerebbe il
    // sospetto su un handler che il lock guarda davvero. La differenza si misura
    // togliendo `scuola_id` dall'INSERT — questo file torna rosso con
    // `inserimento-senza-sede su candidature_insegnanti`.
    //
    // ⚠️ LIMITE DICHIARATO, perché nessuno lo scopra da solo: la regola d'insieme
    // di questo lock è soddisfatta anche da `staffScuola(supabase, scuolaId, …)`,
    // che nomina una sede per scegliere i destinatari della notifica. Cioè su
    // questo handler il lock certifica che una sede si calcola, non che sia
    // QUELLA a finire nella riga. A dimostrarlo è
    // `__tests__/api/candidature-insegnanti-post.test.ts`, che asserisce
    // `inserts[0].scuola_id` e il 400 sulla sede sconosciuta.

    // ── Gestione delle sedi stesse ───────────────────────────────────────────
    // ⚠️ Questa voce diceva «gestione sedi (Direzione): opera SULLE sedi, quindi
    // non dentro una», e con quella frase esentava TUTTO il file. Era vera per
    // l'admin di tre plessi e falsa per il `coordinator`, che per modello ne ha
    // uno solo (`scope.ts:58`): il 2026-07-31 un coordinator di Giugliano
    // riceveva 200 da `PATCH {"id":"<altra sede>"}` e poteva disattivare un
    // plesso vero. Il lock non aveva sbagliato a misurare — gli era stato detto
    // di non guardare. Da oggi GET e PATCH filtrano/verificano con
    // `scuoleDiUtente` e il POST è riservato all'admin (test:
    // `__tests__/api/schools-patch-in-scope.test.ts`), quindi l'esenzione NON
    // copre più nessun handler: resta solo per l'helper `adminDaCollegare`, che
    // legge `utenti` e `utenti_scuole` di TUTTI i plessi perché deve agganciare
    // ogni admin reale alla sede appena creata — filtrarlo per sede la farebbe
    // nascere senza Direzione.
    'admin/schools:<modulo>': "helper `adminDaCollegare`: legge gli admin di TUTTE le sedi perché la sede NUOVA non ha ancora un plesso a cui appartenere, e senza quel collegamento nascerebbe senza Direzione (gli account di collaudo sono esclusi da `isUtenteCollaudo`). Gli HANDLER non sono più esentati: GET filtra con `scuoleDiUtente`, PATCH verifica l'id richiesto, POST è solo admin",

    // ── Contabilità: l estratto conto è UNICO per la cooperativa ─────────────
    // Decisione del 2026-07-19, non una dimenticanza: il conto corrente è uno
    // solo e i movimenti bancari non hanno una sede finché non sono abbinati.
    // La minimizzazione c'è ed è per sede: il NOME del minore compare solo per i
    // plessi in scope (vedi il commento in testa a `pagamenti/riconciliazione`).
    'pagamenti/riconciliazione:GET': 'estratto conto unico: le righe bancarie non hanno sede finché non sono abbinate; il nome del minore nei suggerimenti è filtrato per sede attiva',
    'pagamenti/riconciliazione:POST': 'dedup GLOBALE sull hash del movimento (UNIQUE non più per sede) + lettura dei pagamenti aperti per abbinamento cross-sede',
    'pagamenti/transazioni:POST': 'incasso unico di famiglia: le voci sono verificate una per una contro le sedi attive prima di registrare',
    'pagamenti/transazioni/[id]:GET': 'dettaglio di una transazione già verificata: incassi e crediti si leggono per `transazione_id`',
    'pagamenti/transazioni/[id]/annulla:POST': 'annullo atomico via RPC sulla transazione già verificata (`p.transazione_id`)',
    'pagamenti/incassi/storno:<modulo>': 'helper: ricalcola lo stato del pagamento appena stornato (`p_id` della riga verificata dal chiamante)',
    'pagamenti/cassa/movimenti/storno:POST': 'storno del movimento di cassa già letto e verificato in questo handler',
    'pagamenti/[id]:PATCH': 'la riga è letta e la sua `scuola_id` confrontata con le sedi attive (404 se fuori); le RPC ricalcolano lo stato di QUELLA riga',
    'pagamenti/[id]:DELETE': 'stessa lettura+confronto della PATCH prima di cancellare',
    'pagamenti/[id]/sconto:POST': 'sconto sul pagamento già verificato contro le sedi attive',
    'pagamenti/attestazione:GET': 'attestazione fiscale di UN alunno, il cui scope è verificato prima (staff in sede o genitore del bambino)',
    'pagamenti/famiglia:GET': 'prospetto della FAMIGLIA: gli alunni sono i figli, che possono stare in plessi diversi; lo staff resta limitato ai propri',
    'pagamenti/genera:GET': 'anteprima generazione rette: gli alunni arrivano già filtrati per sede, la lettura dei pagamenti serve solo a escludere i doppioni per `gruppo`',
    'pagamenti/genera:POST': 'generazione rette: idem, e ogni riga creata prende la `scuola_id` DELL ALUNNO',
    'pagamenti/genera-rette:GET': 'anteprima annuale: esclude i periodi già generati per gli alunni già filtrati per sede',
    'pagamenti/fattura/sync:POST': 'sincronizzazione SDI: interroga il provider sulle fatture in volo, che sono di tutte le sedi; ogni aggiornamento è per `id` della fattura',
    'pagamenti/ticket:GET': 'saldo ticket mensa di UN alunno, il cui accesso è verificato prima (staff o genitore)',

    // ── Modulistica: i modelli GLOBALI (scuola_id NULL) esistono per progetto ──
    // Semantica decisa il 2026-07-31: NULL = globale, leggibile da tutti,
    // modificabile solo da chi ha in scope tutte le sedi reali. Il gate è
    // `esitoScopeModello`, che quel caso lo tratta apposta.
    'admin/forms/models:GET': 'elenco modelli: filtro `.or(globali + sedi in scope)` costruito in una variabile',
    'admin/form-models/reset:POST': 'ripristina il modello di iscrizione STANDARD, che è globale per progetto',
    'admin/forms/submissions/[id]:PATCH': "compilazione letta e verificata per sede prima dell'aggiornamento",
    'forms/send-otp:POST': "compilazione pubblica: la sede è quella del MODELLO, non dell'operatore",
    'forms/send-otp:PATCH': 'firma OTP sulla compilazione appena verificata',
    'forms/send-otp:<modulo>': "helper: scrive l'OTP sulla compilazione indicata dal chiamante, che l'ha già verificata",
    'teacher/uscite:GET': 'moduli di uscita didattica delle proprie sezioni (docente), risolte da `sezioniDiUtente`',

    // ── Oblio GDPR: per definizione NON si ferma al confine della sede ───────
    // Cancellare «solo nella mia sede» sarebbe una cancellazione finta.
    'gdpr/retention-iscrizioni:POST': 'conservazione a 24 mesi: come l\'oblio, deve valere su TUTTE le sedi — una domanda mai evasa scade allo stesso modo a Giugliano, Aversa e Cesa, e un filtro di sede qui lascerebbe indietro i plessi che il job non conosce. Nessun utente da cui derivare uno scope: la chiama pg_net.',
    // Gemella della voce qui sopra, e per le stesse due ragioni — che vale la pena
    // scrivere per esteso invece di rimandare, perché un'esenzione che si giustifica
    // con «come quell'altra» è un'esenzione che nessuno ha più riletto.
    //
    // (1) UN TERMINE DI CONSERVAZIONE NON HA CONFINI DI SEDE. Il curriculum di chi si
    //     candida scade dodici mesi dopo la ricezione a Giugliano esattamente come ad
    //     Aversa e a Cesa: è una promessa fatta alla persona nell'informativa, non un
    //     dato da mostrare a un utente. Un `.in('scuola_id', plessi)` qui non
    //     proteggerebbe nessuno — lascerebbe indietro i plessi che il job non conosce,
    //     e li lascerebbe indietro IN SILENZIO, perché il conteggio nel battito
    //     direbbe comunque «ok».
    // (2) NON C'È NESSUN UTENTE DA CUI DERIVARE UNO SCOPE. La chiamante è pg_net
    //     (`candidature_retention_http()`, `5 5 * * *`), autenticata con l'header
    //     `x-cron-secret`. Il lancio manuale dello staff passa da `requireStaff`, ma
    //     fa lo stesso identico lavoro: la conservazione non è un elenco che cambia a
    //     seconda di chi guarda.
    //
    // Le due righe che questo lock segnala sono la lettura delle candidature scadute
    // e la loro cancellazione. La sede la porta comunque la riga (`scuola_id NOT NULL`
    // con FK a `schools`): non si perde nulla, semplicemente non si filtra.
    'gdpr/retention-candidature:POST': 'conservazione delle candidature spontanee (12 mesi, 24 col consenso), curriculum compreso: come l\'oblio, il termine deve valere su TUTTE le sedi — un curriculum scade allo stesso giorno a Giugliano, Aversa e Cesa, e un filtro di sede qui lascerebbe scoperti in silenzio i plessi che il job non conosce. Nessun utente da cui derivare uno scope: la chiama pg_net col cron secret.',
    // ── La SPAZZATA DEGLI ORFANI, che sta FUORI dall'handler (2026-08-15) ─────
    //
    // Perché è una voce a sé e non l'ha coperta quella qui sopra: `spazzaCurriculumOrfani`
    // è una funzione di modulo, e questo lock tratta il codice fuori da ogni handler come
    // uno span suo (`<modulo>`). È il progetto, non un incidente — un'esenzione data al
    // `POST` non deve estendersi in silenzio a un helper che qualcuno scriverà dopo — ed è
    // il motivo per cui questa riga esiste invece di essere già inclusa.
    //
    // COSA SEGNALA IL LOCK: `.from('candidature_insegnanti').select('cv_path').in('cv_path',
    // lotto)`, una lettura d'elenco su una tabella che `scuola_id` ce l'ha, senza filtro di
    // sede. La forma è quella giusta da segnalare; qui la risposta è che il filtro non ci
    // deve stare, e la ragione è più forte di «serve su tutte le sedi».
    //
    // ⚠️ UN FILTRO DI SEDE QUI NON PROTEGGEREBBE: CANCELLEREBBE. L'elenco di partenza non
    // viene dal database — viene dallo STORAGE, `list('candidature')`, e un oggetto in un
    // bucket non ha una sede. La domanda che questa query pone è «quale di questi percorsi
    // è reclamato da UNA QUALUNQUE riga?», e il job cancella tutto ciò che nessuna riga
    // nomina. Restringere la domanda a un plesso significa rispondere «nessuno» per i
    // curriculum reclamati dagli altri due, cioè dichiararli orfani e RIMUOVERLI: la
    // candidatura di Aversa resterebbe viva con un `cv_path` che punta a un file che non
    // c'è più. È il caso in cui il filtro di sede è esattamente il difetto, non il presidio.
    //
    // COSA NON LEGGE, che è la metà che rende la voce difendibile: una sola colonna,
    // `cv_path`, e solo per i percorsi che ha già in mano. Nessun nome, nessun recapito,
    // nessun conteggio: la risposta è un sottoinsieme dell'input, e a leggerla è un cron.
    // Nessun utente da cui derivare uno scope — la chiama pg_net con `x-cron-secret`, e il
    // lancio manuale dello staff passa da `requireStaff` ma fa lo stesso identico lavoro.
    'gdpr/retention-candidature:<modulo>': "helper `spazzaCurriculumOrfani`: chiede quali percorsi elencati nello STORAGE siano reclamati da una riga, per rimuovere quelli che non lo sono. L'elenco di partenza viene dal bucket, dove un oggetto non ha una sede: un `.in('scuola_id', plessi)` qui non restringerebbe una lettura, dichiarerebbe ORFANI i curriculum reclamati dalle altre due sedi e li cancellerebbe, lasciando quelle candidature con un `cv_path` che punta al nulla. Legge una sola colonna (`cv_path`) e solo per i percorsi che ha già in mano: la risposta è un sottoinsieme dell'input. Nessun utente da cui derivare uno scope: la chiama pg_net col cron secret.",
    // `admin/gdpr/erase:POST` NON è più qui, e non perché la regola sia cambiata.
    // Dal 2026-08-02 quella route non interroga più nessuna tabella per conto suo:
    // fa il gate (`assertAlunnoInScope`, che il confine di sede lo verifica eccome,
    // PRIMA di qualunque effetto) e poi chiama `anonimizzaAlunno`/`anonimizzaParent`.
    // La bonifica che insegue il minore ovunque compaia — movimenti bancari, cassa,
    // riconciliazione — è rimasta identica, ma vive in `src/lib/gdpr/esegui.ts`, dove
    // sta scritta anche la ragione per cui non si restringe alla sede (il titolare
    // del trattamento è la cooperativa, una sola per i tre plessi). Il lock scandisce
    // gli handler, non le librerie: lasciare qui la voce significherebbe regalare
    // l'esenzione alla prossima route che nascesse con questo nome.

    // ── Anagrafica: la ricerca del CF ALTROVE è deliberata ───────────────────
    // Serve a distinguere «bambino nuovo» da «bambino di un altra sede»: legge
    // SOLO `scuola_id`, mai il resto della riga, e non produce mai un riuso.
    'admin/import/anagrafiche:POST': 'ricerca del CF nelle altre sedi (solo `scuola_id`) per non fondere due bambini omonimi',
    'admin/iscrizioni:PATCH': "idem in fase di approvazione + aggiornamento della classe sull'alunno già dedotto in sede",
    'admin/pre-inscriptions:PATCH': "recupero dell'account genitore per email quando l'utente auth esiste già",

    // ── Protocollo (DPR 445): registro WORM, numerazione per sede ────────────
    'admin/protocolli:GET': 'catena delle risposte di un protocollo già verificato (`collegato_a_id`)',
    'admin/protocolli:PATCH': 'annullo/rettifica del protocollo già verificato: il registro è WORM e il trigger impedisce la riscrittura',
    'admin/protocolli:DELETE': 'unico percorso di DELETE ammesso dal trigger WORM: RPC `protocollo_elimina` sul protocollo verificato',
    'admin/protocolli/rettifica:POST': 'RPC di rettifica sul protocollo verificato (`p_id`)',
    'admin/protocolli/da-documento:<modulo>': "helper: legge nome e cognome dell'alunno citato nel protocollo, già verificato dal chiamante",

    // ── Helper di file: la sede la porta il chiamante ────────────────────────
    'admin/competenze:<modulo>': 'helper `sedeDellaSezione`: È la funzione che RISOLVE la sede, non una che la dimentica',
    'mensa/alternative:<modulo>': "helper: risolve la sede dell'alunno per il gate (stessa forma)",
    'admin/pagamenti/sospensione:<modulo>': "helper: sospende/riattiva l'alunno indicato dal chiamante, che lo ha verificato",
    'admin/merch/articoli:<modulo>': "helper: aggiorna l'articolo per id, verificato dal chiamante",
    'admin/merch/ordini-fornitore/checkin:<modulo>': "helper: chiude l'ordine fornitore quando tutte le sue righe sono arrivate",
    'mensa/prenotazioni:<modulo>': "helper: disdetta+riaccredito sull'alunno indicato dal chiamante (RPC atomica)",
    'tasks:<modulo>': 'helper: risolve nome e ruolo di un utente per id, per mostrarli nella bacheca',
    'fea/receipt:<modulo>': 'helper: risolve la ricevuta di firma per id; il gate è il token della ricevuta',
    // Archivio dei documenti firmati (2026-08-13). Due letture per id, entrambe
    // seguite dal gate vero:
    //  · `documenti-firmati/dettaglio` legge la submission/il documento PER RISOLVERE
    //    a quale alunno appartiene — non si può filtrare per una sede che si scopre
    //    solo dopo aver letto la riga. Subito dopo passa da `assertAlunnoInScope` e,
    //    se il documento è sanitario, da `puoAccedereFascicolo`.
    //  · `documenti-firmati:GET` legge i TITOLI dei modelli il cui id compare nelle
    //    submission di alunni già filtrati per sede. Un filtro di sede qui
    //    escluderebbe i modelli globali (`forms_templates.scuola_id = null`), che
    //    valgono per tutte e tre le sedi: lascerebbe le righe senza nome.
    'documenti-firmati/dettaglio:<modulo>': "helper: risolve l'alunno del documento indicato; il gate (assertAlunnoInScope + puoAccedereFascicolo) gira subito dopo, sull'alunno risolto",
    'documenti-firmati:GET': 'titoli dei modelli citati dalle submission di alunni già filtrati per sede; i modelli globali hanno scuola_id nullo',

    // ── Merch: le righe appena create, e il loro rollback ────────────────────
    'pagamenti/rate:POST': "piano rate: il `delete` è il rollback del pagamento padre appena creato in QUESTA richiesta (le rate figlie non sono state scritte), e la sede di ogni riga viene dall'alunno verificato",
    'admin/merch/ordini:POST': 'ordine divise: gli articoli sono validati (attivi, STESSA scuola) prima di ordinarli; i `delete` sono il rollback delle righe appena create in questa richiesta',

    // ── Configurazione: categorie di pagamento globali ───────────────────────
    'admin/search:GET': 'ricerca globale della Direzione: i modelli di modulo sono per lo più globali; alunni e persone nella stessa route sono filtrati per sede',
    'admin/segnalazioni:PATCH': 'presa in carico della segnalazione già letta e verificata',

    // ── Registro e diario: lo scope è la SEZIONE, verificata a monte ─────────
    'primaria/appello:POST': 'appello: la sezione è verificata; la lettura dei nomi serve alle notifiche degli assenti appena registrati',
    'primaria/classe/[sectionId]:GET': 'materie della sezione verificata (`materieDiDocenteInSezione`)',
    'primaria/prospetto:GET': "materie della sezione dell'alunno verificato",
    'primaria/registro:GET': 'nomi dei docenti che hanno firmato le righe già lette per sezione',
    'avvisi/[id]/risposte:POST': 'risposta a un avviso già verificato: la riga esistente si cerca per `avviso_id`',
    // ⚠️ Queste due voci dicevano «il media è letto, l'autorizzazione verificata
    // e poi aggiornato per id», e con quella frase esentavano l'INTERO handler.
    // Era più larga della realtà, e la larghezza si è pagata: il `PATCH`
    // accettava `tag_students` di minori di un'altra sede e il Privacy Lock ne
    // restituiva NOME e COGNOME nel 422 (T05-F1, 2026-08-03). Il lock non aveva
    // sbagliato a misurare — gli era stato detto di non guardare quell'handler.
    // Ora ogni voce nomina LA QUERY che copre, e niente di più: il gate dei tag
    // (`assertTagStudentsInScope`) e l'aggiornamento per id sono presìdi veri, e
    // questo lock li riconosce da sé.
    'gallery:PATCH':
        "una sola lettura resta senza filtro di sede, ed è quella dei media caricati DA CHI CHIAMA " +
        "(`select('tag_students').eq('uploaded_by', <identità del gate>)`): serve a dedurre le classi del " +
        'docente, la chiave è la sua stessa identità e non un id scelto dal client, e gli alunni che ne ' +
        "escono sono subito ristretti con `.in('scuola_id', plessi)`. Tutto il resto dell'handler è " +
        'presidiato: il media è letto per id e la sua `scuola_id` confrontata con `scuoleDiUtente` prima ' +
        'di ogni valutazione, i tag passano da `assertTagStudentsInScope` e la riga si riscrive per id.',
    'gallery:DELETE':
        'la stessa lettura dei propri media (stessa chiave, stessa ragione), più il `delete().eq(\'id\', id)` ' +
        'sulla riga già letta e verificata per sede in questo stesso handler: il confronto è scritto a mano ' +
        '(`plessi.includes(sedeMedia)`) e il lock non lo riconosce come gate, ma nega eccome — è il primo ' +
        'blocco della DELETE, prima di qualunque permesso.',
    // `diary/checkin:GET`, `locker/inventory:GET` e `locker/inventory:POST`
    // stavano qui e dicevano «di UN alunno, verificato prima». NON era vero: la
    // verifica esisteva solo per il genitore. Ora esiste per tutti
    // (`requireParentOfStudent` → `assertAlunnoInScope`) e l'esenzione non serve
    // più — vedi la nota in cima al blocco «scope FAMIGLIA».

    // ── Il debito che era dichiarato qui è stato ASSOLTO (2026-07-31) ────────
    // `tasks:GET` e `tasks:POST` stavano in questo elenco come promemoria: la
    // bacheca interna era l'ultima cosa con una semantica mono-sede — nasceva
    // con `auth.user.scuola_id` (la sede PRIMARIA di chi scrive) e si leggeva
    // con `scuoleDiUtente` invece che con le sedi attive. Le due voci sono state
    // tolte quando il debito è stato pagato davvero: `resolveScuolaScrittura` in
    // scrittura, `resolveScuoleAttive` in lettura, e la migrazione
    // `task_interni_scuola_obbligatoria` che rende `scuola_id` NOT NULL (la
    // tabella era vuota in produzione: 0 righe, verificato lo stesso giorno).
    // Resta solo la voce `tasks:<modulo>` qui sopra, che è un'altra cosa.
}

// ─────────────────────────────────────────────────────────────────────────────
// I TEST
// ─────────────────────────────────────────────────────────────────────────────

/** Tutte le scoperte del repo, con la loro chiave di allowlist. */
function scopertureDelRepo(): { chiave: string; dettaglio: string }[] {
    const out: { chiave: string; dettaglio: string }[] = []
    for (const f of FILES) {
        const src = fs.readFileSync(f, 'utf8')
        // Solo il client service-role: dove c'è la RLS, il gate applicativo non è
        // l'unico presidio. Sul CODICE, non sui commenti: vedi `usaServiceRole`.
        if (!usaServiceRole(src)) continue
        for (const s of scoperte(src)) {
            out.push({
                chiave: `${nomeRoute(f)}:${s.handler}`,
                dettaglio: `${path.relative(process.cwd(), f)}:${s.riga} — ${s.motivo} su \`${s.tabella}\``,
            })
        }
    }
    return out
}

describe('coverage-lock isolamento fra sedi', () => {
    it('la fotografia delle tabelle non è stata addomesticata a mano (sha256)', () => {
        // Stesse chiavi e stesso ordine di `normalizza()` in
        // scripts/tabelle-sede-fotografia.mjs: l'impronta copre il contenuto.
        const contenuto = { con_scuola_id: foto.con_scuola_id, legate_all_alunno: foto.legate_all_alunno }
        const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
        expect(
            foto.sha256,
            `La fotografia non corrisponde al suo sha256: qualcuno l'ha modificata a mano invece di ` +
            `rigenerarla — ed è il modo più semplice di far tacere questo lock. ${COME_RIGENERARE}`,
        ).toBe(atteso)
    })

    it('ci sono route e tabelle da controllare (se cade, il lock si sta autoingannando)', () => {
        // Un lock che gira su zero file o zero tabelle passa sempre: è il modo più
        // silenzioso di non controllare niente.
        expect(FILES.length).toBeGreaterThan(200)
        expect(CON_SEDE.size).toBeGreaterThan(55)
        expect(LEGATE_ALUNNO.size).toBeGreaterThan(15)
        for (const t of ['alunni', 'presenze', 'pagamenti', 'form_submissions', 'audit_scritture_docente']) {
            expect(CON_SEDE.has(t), `${t} deve essere fra le tabelle di sede`).toBe(true)
        }
        // E deve esistere davvero del codice che il rilevatore ESAMINA: se un
        // domani il ritaglio delle catene si rompesse, il lock resterebbe verde
        // per il motivo sbagliato.
        const conQuery = FILES.filter((f) => {
            const { senzaCommenti, struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
            return unitaDiQuery(senzaCommenti, struttura).some((u) => SENSIBILI.has(u.tabella))
        })
        expect(conQuery.length).toBeGreaterThan(120)
    })

    it('ogni handler service-role che tocca dati di sede dichiara il suo scope', () => {
        const scoperti = scopertureDelRepo().filter((s) => !(s.chiave in AMMESSE))
        expect(
            scoperti.map((s) => `${s.chiave}  ←  ${s.dettaglio}`),
            'Handler che leggono o scrivono dati di una sede senza dirlo nella query. ' +
            'Aggiungi il filtro (`.in(\'scuola_id\', plessi)`), il gate (`assert…InScope`) o ' +
            '`resolveScuolaScrittura` — oppure, se davvero non serve, una voce in AMMESSE con la ' +
            'ragione scritta per esteso.',
        ).toEqual([])
    })

    it("l'allowlist non contiene voci morte (una route corretta o cancellata la lascerebbe indietro)", () => {
        const vive = new Set(scopertureDelRepo().map((s) => s.chiave))
        expect(
            Object.keys(AMMESSE).filter((k) => !vive.has(k)),
            "Voci di allowlist che non servono più: l'handler è stato corretto o cancellato. " +
            "Vanno tolte, o la prossima route che nasce con quel nome eredita un'esenzione che " +
            'nessuno ha mai deciso per lei.',
        ).toEqual([])
    })

    it('i NUMERI della copertura sono quelli attesi (chi allarga l\'allowlist lo dice)', () => {
        // Una fotografia, non una soglia. Se domani qualcuno aggiunge una voce in
        // AMMESSE questo test diventa rosso e va aggiornato A MANO: è il momento
        // in cui la decisione passa sotto gli occhi di qualcuno. Un lock che si
        // allarga in silenzio non è un lock.
        const serviceRole = FILES.filter((f) => usaServiceRole(fs.readFileSync(f, 'utf8')))
        const handlerControllati = new Set<string>()
        for (const f of serviceRole) {
            const { struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
            for (const h of handlerDi(struttura)) handlerControllati.add(`${nomeRoute(f)}:${h.metodo}`)
        }
        expect(
            {
                routeConServiceRole: serviceRole.length,
                handlerControllati: handlerControllati.size,
                handlerEsentati: Object.keys(AMMESSE).length,
            },
            'I numeri della copertura sono cambiati. Se hai aggiunto una route o un handler, ' +
            'aggiorna i primi due. Se è cresciuto `handlerEsentati`, fermati: hai appena tolto ' +
            'un pezzo di questo lock, e questo test esiste perché la cosa passi sotto gli occhi ' +
            'di qualcuno invece che in silenzio.',
        ).toEqual({
            // 272 → 273 e 432 → 433 il 2026-08-01: è nata `avvisi/upload/rimuovi:POST`, la
            // route che butta via l'allegato di una bozza abbandonata (S35). Non porta
            // nessuna esenzione — `handlerEsentati` è fermo — perché non tocca nessuna
            // tabella: la sola query su `avvisi` vive in `src/lib/allegati/rimozione.ts`, ed
            // è deliberatamente SENZA filtro di sede (il bucket è uno per tutte e tre: se un
            // avviso di un altro plesso punta a quell'oggetto, il file resta).
            // 273 → 274 e 433 → 434 il 2026-08-01: è nata `gdpr/retention-iscrizioni:POST`,
            // che sostituisce il pezzo SQL della conservazione a 24 mesi. Quello cancellava
            // i file con `DELETE FROM storage.objects`, cosa che Postgres vieta (trigger
            // `protect_objects_delete`, FOR EACH STATEMENT): falliva a ogni esecuzione, e
            // falliva PRIMA di scrivere la riga di log che avrebbe dovuto segnalarlo.
            // Porta UNA esenzione, dichiarata in AMMESSE: come l'oblio, la conservazione
            // deve valere su tutte le sedi.
            // 274 → 275 e 434 → 435 il 2026-08-04: è nato `health:GET`, l'endpoint di
            // salute (rilievo T20-F5 — fino a quel giorno l'unico rilevatore di guasti in
            // produzione era la telefonata di un genitore). Usa il service role perché
            // deve poter leggere `app_log` e sondare lo schema anche quando nessuna
            // sessione esiste — che è il caso in cui serve.
            //
            // NON porta nessuna esenzione, e `handlerEsentati` resta fermo a 92: è il
            // punto che vale la pena guardare. Un endpoint di salute non legge dati di
            // nessuna sede — conta impronte d'errore, verifica che una tabella risponda,
            // guarda l'ora dell'ultimo battito di un cron. Non c'è niente da isolare
            // perché non c'è niente di nessuno. Se un domani qualcuno gli facesse
            // restituire un conteggio per sede, quel numero dovrebbe salire, e questo
            // lock è il posto dove il fatto diventerebbe visibile.
            // 435 → 436 il 2026-08-07: è nato
            // `parent/presenze/comunica-assenza:DELETE`, l'annullamento della
            // comunicazione d'assenza da parte del genitore. NON porta esenzioni:
            // legge la riga per `(alunno_id, data)` — che è una chiave unica
            // (`unique_presenza_giornaliera`) — e la cancella con LE STESSE
            // chiavi, una delle quali è l'identità che `requireParentOfStudent`
            // ha appena verificato.
            // 436 → 441 e 275 → 279 il 2026-08-10: sono QUATTRO route, nate lo
            // stesso giorno con il modulo «Lavora con noi». Vale la pena
            // nominarle una per una — un +4 senza attribuzione è il modo in cui
            // una route entra in questo inventario senza che nessuno l'abbia
            // guardata:
            //
            //  · `iscrizione/insegnanti:POST` — la porta PUBBLICA del modulo, ed
            //    è l'unica che questa riga VERIFICA. NON porta esenzioni, ed è
            //    il punto che vale la pena guardare: l'INSERT è anonimo, ma la
            //    sede la DICHIARA, e la dichiara con un valore accettato solo se
            //    compare fra le sedi note lette da `sediReali`. La ragione per
            //    esteso sta in AMMESSE — dove la voce NON c'è, e c'è scritto
            //    perché.
            //  · `admin/candidature-insegnanti` — il cockpit di segreteria.
            //  · `gdpr/retention-candidature:POST` — la conservazione delle
            //    candidature, che porta con sé le proprie esenzioni (come
            //    `gdpr/retention-iscrizioni:POST`: l'oblio non si ferma al
            //    confine della sede).
            //  · `admin/anagrafiche/codici-fiscali:GET` — la lettura dei codici
            //    fiscali per la segreteria.
            //
            // Le ultime tre arrivano dalle corsie accanto e sono contate qui, non
            // certificate: chi le ha scritte dichiara le proprie esenzioni sotto
            // e muove `handlerEsentati`, che è la sola metà di questi tre numeri
            // a misurare una difesa invece di un inventario — ed è rimasta FERMA
            // a 91 in questo passaggio. Chi rilegge ricalcoli invece di fidarsi:
            // il messaggio del test dice come.
            // 🔻 441 → 442 e 279 → 280 il 2026-08-10, POI RIPORTATI a 441 e 279
            // LO STESSO GIORNO, e la ragione va scritta per esteso perché è la
            // trappola che questo file esiste per non ripetere.
            //
            // Quella riga diceva: «`anagrafiche/comuni:GET` … è passata a
            // `createAdminClient` mentre questa riga veniva scritta. MISURATA,
            // non dedotta». Era FALSA, e il modo in cui lo era è il punto: quella
            // route non importa e non chiama `createAdminClient`, mai. Entrava in
            // questo conteggio perché la sua TESTATA contiene la stringa
            // `createAdminClient()` dentro un commento — la riga che spiega che è
            // `rateLimit()` ad aprirlo — e `USA_SERVICE_ROLE` veniva applicata al
            // sorgente GREZZO. La «misura» aveva misurato una prosa: riscrivere
            // quel commento senza toccare una riga di codice faceva scendere il
            // numero a 279.
            //
            // Corretto alla radice, non qui: la regex ora si applica al codice
            // (`usaServiceRole`, in cima al file, con la misura che dice perché
            // nessun altro file cambia lato). Questi due numeri tornano al valore
            // vero, e `handlerEsentati` non si muove — nessun presidio è stato
            // tolto, è sparito un falso positivo.
            //
            // Quello che resta VERO, e che nessuno tolga credendo di far pulizia:
            // a runtime quella route TOCCA il database con il service role, in
            // modo TRANSITIVO, perché `rateLimit()` apre il client e scrive sul
            // contatore del tetto — una scrittura per richiesta, provocabile da un
            // anonimo. Questo lock non lo vede e non deve pretendere di vederlo:
            // legge il codice di un file `route.ts`, non il grafo dei moduli. Se
            // il criterio fosse «service role per via transitiva», dentro
            // dovrebbero starci tutte le route che chiamano `rateLimit(` — sono
            // 21, misurate lo stesso giorno, e 19 sono già qui per una ragione
            // loro (usano il client in proprio) mentre `chat/translate` e `logs`
            // non ci sono affatto. Cioè: come voce transitiva questa era l'unica
            // presente su tre, e per caso. Il perimetro di sede di quella route è
            // dichiarato altrove ed è la scelta giusta: `PUBBLICHE` in
            // `gate-coverage`, con la sua ragione scritta — un elenco di comuni
            // italiani non è dato di nessuna sede, non c'è niente da isolare
            // perché non c'è niente di nessuno.
            //
            // 279 → 283 il 2026-08-11, e sono i QUATTRO FILE nuovi di questo branch —
            // `iscrizione/personale`, `iscrizione/personale/upload`,
            // `gdpr/retention-personale`, `notifiche/scadenze-documenti` — che aprono
            // tutti il client con il service role. Questo numero conta i FILE, non gli
            // handler: le prime due rotte hanno un solo metodo ciascuna, le altre due
            // pure, quindi qui il +4 e sotto il +4 coincidono per caso e non per regola.
            //
            // 283 → 285 il 2026-08-12, e sono DUE file, di due corsie diverse dello
            // stesso branch. Uno solo lo CERTIFICA questa riga:
            //
            //  · `admin/anagrafica-personale` (GET + PATCH) — il cruscotto delle
            //    scadenze dei documenti, lato Segreteria. NON porta esenzioni, e il
            //    punto che vale la pena guardare è la forma della sua lettura:
            //    `anagrafica_personale` non ha `scuola_id` (la sede sta in `utenti`),
            //    quindi l'elenco è agganciato agli id ricavati da una query PRECEDENTE
            //    che il filtro di sede ce l'ha dentro — la forma che le regole in testa
            //    a questo file ammettono per nome. Il `PATCH` passa da
            //    `assertUtenteInScope` prima di qualunque scrittura.
            //  · `admin/pratiche-personale` — arriva dalla corsia accanto ed è contata
            //    qui, non certificata: chi l'ha scritta dichiari le proprie esenzioni.
            //    `handlerEsentati` è rimasto FERMO a 92 in questo passaggio, ed è la
            //    sola metà di questi tre numeri che misura una difesa invece di un
            //    inventario. Chi rilegge ricalcoli invece di fidarsi.
            //
            // 285 → 289 il 2026-08-12 (secondo giro dello stesso branch): QUATTRO file
            // nuovi, e uno solo lo CERTIFICA questa riga.
            //
            //  · `admin/anagrafica-personale/scansione` (POST) — la porta con cui la
            //    Segreteria carica fronte e retro del documento dalla scheda della
            //    persona. NON porta esenzioni. La sua difesa di sede è
            //    `assertUtenteInScope` sul BERSAGLIO, chiamata prima del corpo della
            //    richiesta: l'identificativo viaggia in query proprio perché il gate
            //    possa girare senza aver bufferizzato 4 MB. `anagrafica_personale` e
            //    `caricamenti_personale` non hanno `scuola_id` (la sede sta in
            //    `utenti`), quindi non c'è nessun filtro di colonna da cercare qui.
            //  · `admin/students/archivia`, `admin/students/libera-spazio`,
            //    `admin/students/riattiva` — arrivano dalla corsia accanto e sono
            //    contate qui, non certificate: chi le ha scritte dichiari le proprie
            //    esenzioni.
            // 289 → 291 il 2026-08-13: l'archivio dei documenti firmati porta due
            // route nuove (`documenti-firmati:GET`, `documenti-firmati/dettaglio:GET`).
            // 291 → 295 il 2026-08-14: la modulistica prestampata, e le quattro route
            // vanno nominate una per una — un +4 senza attribuzione è il modo in cui una
            // route entra in questo inventario senza che nessuno l'abbia guardata:
            //
            //  · `prestampati:GET` e `prestampati/genera:POST` — lo sportello della
            //    segreteria. NON portano esenzioni: sull'ALUNNO il gate è
            //    `caricaPrefillAlunno` (che chiama `requireParentOfStudent`) più
            //    `resolveScuoleAttive`, sulla SEZIONE è `assertSezioneInScope` più le sedi
            //    attive passate a `caricaSezione`, e la generazione dichiara la sede con
            //    `resolveScuolaScrittura` prima di leggere qualunque cosa. La query dei
            //    bambini di una sezione filtra per `scuola_id` oltre che per `section_id`,
            //    perché da quando le sedi sono tre il nome di una classe non è più una
            //    chiave univoca.
            //  · `parent/prestampati:GET` e `parent/prestampati/firma` — il flusso della
            //    famiglia, che arriva dalla corsia accanto: contate qui, non certificate.
            //    Chi le ha scritte dichiari le proprie esenzioni.
            //
            // 295 → 296 il 2026-08-15: è nata `iscrizione/insegnanti/upload:POST`, la porta
            // pubblica da cui chi si candida allega il curriculum. Apre il client con il
            // service role perché deve scrivere nello Storage senza nessuna sessione — chi
            // carica non ha un account e non può averlo, l'account nasce semmai quando la
            // Direzione approva.
            //
            // ⚠️ IL +1 È MISURATO, NON DEDOTTO, e vale la pena dire come — perché due righe
            // più in basso questo stesso file racconta di un +4 che quadrava per caso e
            // nascondeva l'uscita di un handler. Ricontando l'intero repo con quel solo file
            // ESCLUSO si ottengono esattamente 295 e 459, cioè i due valori precedenti: il
            // resto dell'albero non si è mosso, e il delta è tutto di questa rotta. (Resta
            // fuori dalla portata di questa misura un +1 e un −1 che si annullino altrove:
            // questo lock CONTA, non fa la differenza con ieri.)
            //
            // NON porta esenzioni, ed è il punto da guardare: la rotta non tocca nessuna
            // tabella. Scrive un oggetto in `form_attachments` e restituisce il percorso —
            // nessun `.from(`, nessun `.rpc(` — quindi qui non c'è nessuna sede da dichiarare
            // perché non c'è nessuna riga. La riga che nominerà quel file nasce dall'altra
            // porta (`iscrizione/insegnanti:POST`), e QUELLA la sede la dichiara.
            routeConServiceRole: 296,
            // 441 → 440 il 2026-08-11: è USCITO `admin/adults:POST`, cancellato perché
            // irraggiungibile (nessuna pagina montava la sua scheda) e rotto (scriveva le
            // colonne generate di `utenti`: `428C9` a ogni tentativo, dopo aver già invitato
            // l'account auth). Non è un presidio tolto: è un handler che non esiste più.
            //
            // È scritto qui perché questo lock esiste per NON far tornare i conti per caso.
            // Sullo stesso branch nascono quattro handler nuovi (`iscrizione/personale:POST`,
            // `iscrizione/personale/upload:POST`, `gdpr/retention-personale:POST`,
            // `notifiche/scadenze-documenti:POST`): chi li dichiara misura 444 e, senza questa
            // riga, lo legge come «441 + 4» — un'attribuzione che quadra per caso e nasconde
            // l'uscita. Il conto vero è 441 − 1 + 4. `routeConServiceRole` invece NON cambia
            // per questa rimozione: `src/app/api/admin/adults/route.ts` resta contato, il
            // `createAdminClient()` è nel GET, che è vivo.
            //
            // 440 → 444, dichiarato: i quattro handler nuovi ci sono tutti e quattro, e
            // il conto è quello scritto qui sopra (441 − 1 + 4). La riga era rimasta a
            // 440 con i quattro nomi già scritti nel commento: un lock rosso e una
            // spiegazione a fianco è il modo in cui un lock smette di essere creduto —
            // al giro dopo qualcuno legge il rosso «già noto» e ci aggiunge il proprio.
            // `handlerEsentati` NON si muove (92): nessuno dei quattro è in allowlist,
            // che è la sola cosa che questo numero esiste per impedire in silenzio.
            //
            // 444 → 448 il 2026-08-12: QUATTRO handler, due per ciascuno dei due file
            // nominati sopra — `admin/anagrafica-personale:GET`/`:PATCH` (certificati
            // qui) e i due di `admin/pratiche-personale` (contati, non certificati).
            // Il +2 di questa corsia è il cruscotto delle scadenze: nessuno dei due
            // handler è in allowlist, e `handlerEsentati` resta 92.
            //
            // ⚠️ 448 → 451 il 2026-08-12, e il conto NON è «448 + 4»: i file nuovi sono
            // quattro, con un handler ciascuno, ma nello stesso giro ne è USCITO uno
            // (`admin/students:DELETE`, sostituito dall'archiviazione reversibile della
            // corsia accanto). Il conto vero è **448 − 1 + 4 = 451**.
            //
            // È scritto per esteso perché è precisamente ciò che questo lock esiste per
            // impedire: 448 + 3 quadra lo stesso, e quadrando nasconderebbe sia
            // l'ingresso di un handler sia l'uscita di un altro. Chi rilegge ricalcoli
            // invece di fidarsi. `handlerEsentati` NON si muove: nessuno dei quattro
            // handler nuovi è in allowlist, che è la sola cosa che questo numero esiste
            // per impedire in silenzio.
            // 451 → 453 il 2026-08-13: i due handler dell'archivio documenti.
            // 453 → 458 il 2026-08-14, e il conto è **453 + 5** su QUATTRO route: i due
            // dello sportello (`prestampati:GET`, `prestampati/genera:POST`) e i tre della
            // famiglia (`parent/prestampati:GET`, `parent/prestampati/firma:POST` e
            // `:PATCH`) — la route della firma ne porta due, ed è il motivo per cui i due
            // numeri di questa riga non crescono dello stesso passo di quello sopra.
            // `handlerEsentati` non si muove: nessuno dei cinque è in allowlist.
            // 458 → 459 il 2026-08-14: è nato `teacher/uscite:POST`, la creazione
            // dell'uscita didattica che genera da sé l'autorizzazione della famiglia
            // (prestampato n. 10). `routeConServiceRole` NON cambia — quel file è già
            // contato, il `createAdminClient()` del GET c'era da prima — e
            // `handlerEsentati` resta 94, che è il punto da guardare: l'handler NON è in
            // allowlist. Dichiara la sede con `resolveScuolaScrittura` e la scrive su
            // entrambi gli INSERT (`eventi_agenda`, `forms_templates`); le tre letture
            // (`sections`, le uscite già create, i moduli già scritti) portano
            // `.eq('scuola_id', …)` dentro la query, e le sezioni passano una per una da
            // `assertSezioneInScope`. Una gita archiviata nel plesso sbagliato si
            // porterebbe dietro l'autorizzazione, cioè manderebbe il modulo da firmare
            // alle famiglie di un'altra scuola.
            // 459 → 460 il 2026-08-15: l'unico handler della rotta nuova nominata sopra
            // (`iscrizione/insegnanti/upload:POST`). Qui il +1 e il +1 del numero sopra
            // coincidono perché quel file ha un metodo solo, non per una regola — è la
            // stessa coincidenza già dichiarata il 2026-08-11, e va ridichiarata ogni volta
            // o al giro dopo diventa un'aspettativa.
            handlerControllati: 460,
            // 111 → 109 il 2026-07-31: `tasks:GET` e `tasks:POST` non sono più
            // esentati. Questo numero CALA solo quando un debito viene pagato;
            // se sale, qualcuno ha appena tolto un pezzo di questo lock.
            //
            // 109 → 96 lo stesso giorno, ed è il calo più grosso mai registrato:
            // `requireParentOfStudent` verifica il legame di famiglia al genitore
            // e il plesso/sezione a chiunque altro, quindi tredici handler che
            // stavano in allowlist «per scope famiglia» — undici dei quali NON
            // avevano nessuno scope per i ruoli diversi da genitore — hanno ora
            // un presidio vero e non un'esenzione.
            //
            // 96 → 94 il 2026-08-01: tolte tre voci MORTE (`admin/settings/categorie`
            // POST/PATCH/DELETE, il cui handler non ha più la forma che le richiedeva) e
            // aggiunta una sola esenzione nuova e dichiarata
            // (`gdpr/retention-iscrizioni:POST`). Il saldo è −2, cioè un debito pagato:
            // questo numero può calare, e sale solo se qualcuno toglie un presidio.
            //
            // 94 → 93 il 2026-08-02: via anche `admin/gdpr/erase:POST`. Quella route non
            // interroga più nessuna tabella per conto suo — fa il gate di sede e delega a
            // `anonimizzaAlunno`/`anonimizzaParent`, le stesse funzioni degli altri due
            // canali di oblio. Non è un presidio tolto: è la terza copia di una procedura
            // che smette di esistere, e con lei l'esenzione che le serviva.
            //
            // 93 → 92 il 2026-08-03: via `segnalazioni:<modulo>`. Non è una route
            // cancellata, è un debito pagato — e il debito era più grosso di quanto
            // l'esenzione lasciasse credere: la sua ragione («legame genitore↔figlio»)
            // descriveva il ramo dei GENITORI, mentre per docenti, segreteria e admin
            // `verificaAccesso` non aveva alcun controllo, né di sede né d'altro. Ora
            // media e voci di diario si leggono con `.in('scuola_id', sedi)` nella stessa
            // query. Quello che questo lock verifica di quel presidio è però SOLO che
            // una sede venga calcolata (regola d'insieme): i tre filtri non li vede —
            // misurato, vedi la nota accanto alla voce tolta in AMMESSE. La prova sta
            // in `__tests__/api/segnalazioni-scope-sede.test.ts`.
            //
            // 92 → 91 il 2026-08-07: via `parent/presenze/comunica-assenza:POST`.
            // Debito pagato, non presidio tolto: l'upsert su `presenze` ora
            // dichiara `scuola_id`. La differenza si misura togliendo quel campo
            // dalla route — questo lock torna rosso con `scrittura-senza-sede`.
            //
            // 91 → 92 il 2026-08-10: `gdpr/retention-candidature:POST`. È la sola
            // fra le quattro route del modulo «Lavora con noi» che porta
            // un'esenzione, ed è quella prevista dal commento accanto ai due
            // numeri qui sopra: la conservazione, come l'oblio, non si ferma al
            // confine della sede. La ragione per esteso sta in AMMESSE, e questo
            // +1 è il momento in cui la decisione passa sotto gli occhi di
            // qualcuno invece che in silenzio — che è tutto ciò per cui questo
            // test esiste. Le altre tre (`iscrizione/insegnanti:POST`,
            // `admin/candidature-insegnanti`, `admin/anagrafiche/codici-fiscali:GET`)
            // restano a zero esenzioni: sono contate nei due numeri sopra e
            // basta.
            // 92 → 94 il 2026-08-13, ed è un numero che SALE: due letture per id
            // dell'archivio documenti (vedi le ragioni in AMMESSE). Non è un presidio
            // tolto — le due route filtrano per sede la query che conta, quella degli
            // alunni, e chiamano `assertAlunnoInScope` prima di restituire un byte —
            // ma è comunque una decisione, e questo numero esiste perché passi sotto
            // gli occhi di qualcuno invece che in silenzio.
            //
            // 🔻 94 → 95 il 2026-08-15, ed è un numero che SALE: `gdpr/retention-candidature:<modulo>`,
            // cioè l'helper `spazzaCurriculumOrfani` nato con la porta del curriculum. Il
            // commento in testa a questo numero dice che sale solo quando qualcuno toglie
            // un pezzo di questo lock, e la frase va presa sul serio anche quando non è il
            // caso — quindi va scritto perché questa passa.
            //
            // ⚠️ E VA SCRITTO ANCHE CHE NON ERA PREVISTA. Il lavoro che porta la rotta nuova
            // dava per fermo questo numero a 94: la misura dice di no, la spazzata degli
            // orfani legge `candidature_insegnanti` senza filtro di sede e questo lock la
            // vede. Non è un +1 concordato prima e ratificato dopo — è un rosso trovato
            // eseguendo il test, che è la sola ragione per cui il test esiste.
            //
            // Perché passa: qui il filtro di sede non sarebbe un presidio, sarebbe il
            // difetto. L'elenco di partenza viene dallo Storage, dove un oggetto non ha una
            // sede, e il job CANCELLA ciò che nessuna riga reclama: restringere la domanda a
            // un plesso dichiarerebbe orfani i curriculum reclamati dagli altri due e li
            // porterebbe via, lasciando quelle candidature con un `cv_path` che punta al
            // nulla. La ragione per esteso — compreso il perché è uno span `<modulo>` e non
            // l'esenzione del `POST` che gli sta accanto — sta in AMMESSE.
            //
            // La differenza si misura: dando alla query un `.eq('scuola_id', …)` questa voce
            // diventerebbe MORTA (il test «l'allowlist non contiene voci morte» la
            // respingerebbe) e il cron comincerebbe a cancellare curriculum vivi. Cioè: qui
            // l'esenzione è la difesa, non il buco nella difesa.
            //
            // Ciò che tiene ferma l'affermazione non sta qui ma in
            // `__tests__/api/gdpr-retention-candidature.test.ts`, che la spazzata la esercita
            // per davvero: elenca il prefisso, distingue «sotto il prefisso» da «orfano» —
            // che è la distinzione che questa query calcola — e verifica il fail-closed
            // quando la `select('cv_path')` fallisce (nessun orfano rimosso). Se un giorno
            // quel file smettesse di coprire la spazzata, questa voce resterebbe verde
            // sull'esenzione e cieca sul comportamento.
            handlerEsentati: 95,
        })
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda
// più niente si somigliano moltissimo — dall'esterno sono identici. Questi test
// tengono ferme le forme che DEVE vedere e quelle che NON deve segnalare: sono
// i tre punti ciechi della versione precedente, scritti in piccolo.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore riconosce la forma vietata', () => {
    it('elenco da tabella con `scuola_id` senza filtro di sede (era il caso `admin/audit`)', () => {
        const src = `
      export const GET = withRoute('admin/audit:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase
          .from('audit_scritture_docente')
          .select('id, attore_id')
          .order('creato_il', { ascending: false })
        return NextResponse.json({ data })
      })
    `
        expect(scoperte(src)).toEqual([
            { handler: 'GET', riga: 5, tabella: 'audit_scritture_docente', motivo: 'elenco-senza-sede' },
        ])
    })

    it('`resolveScuoleAttive` chiamata ma NON usata come filtro non basta', () => {
        // È la forma esatta che ha resistito all'audit: la sede si calcola, si
        // logga, e poi la query non la usa.
        const src = `
      export const GET = withRoute('admin/audit:GET', async (request) => {
        const supabase = await createAdminClient()
        const sedi = await resolveScuoleAttive(request, supabase, auth.user)
        const { data } = await supabase.from('audit_scritture_docente').select('id').limit(sedi.length)
        return NextResponse.json({ data })
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['elenco-senza-sede'])
    })

    it('il GET coperto NON copre il PATCH nudo (era il caso `admin/students`)', () => {
        const src = `
      export const GET = withRoute('admin/students:GET', async (request) => {
        const supabase = await createAdminClient()
        const plessi = await resolveScuoleAttive(request, supabase, auth.user)
        const { data } = await supabase.from('alunni').select('id').in('scuola_id', plessi)
        return NextResponse.json({ data })
      })

      export const PATCH = withRoute('admin/students:PATCH', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('alunni').update({ stato: 'ritirato' }).in('id', body.ids)
        return NextResponse.json({ data })
      })
    `
        expect(scoperte(src)).toEqual([
            { handler: 'PATCH', riga: 11, tabella: 'alunni', motivo: 'scrittura-senza-sede' },
        ])
    })

    it('un gate su un ALTRO oggetto non copre una scrittura di massa', () => {
        // `assertAlunnoInScope(…, id)` garantisce `id`, non `body.ids`.
        const src = `
      export const PATCH = withRoute('admin/students:PATCH', async (request) => {
        const supabase = await createAdminClient()
        const scopeErr = await assertAlunnoInScope(supabase, auth.user, id)
        if (scopeErr) return scopeErr
        await supabase.from('alunni').update({ classe_sezione: nome }).in('id', body.ids)
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['scrittura-senza-sede'])
    })

    it("un elenco agganciato a un id ARRIVATO DAL CLIENT resta scoperto (era il caso `forms/delibera`)", () => {
        const src = `
      export const POST = withRoute('forms/delibera:POST', async (request) => {
        const supabase = await createAdminClient()
        const bulk = parseData(postBulkSchema, body)
        const { data } = await supabase
          .from('form_submissions')
          .select('id, score')
          .eq('model_id', bulk.data.modelId)
          .eq('status', 'completed')
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['elenco-senza-sede'])
    })

    it('un INSERT che della sede non parla affatto', () => {
        const src = `
      export const POST = withRoute('avvisi:POST', async (request) => {
        const supabase = await createAdminClient()
        await supabase.from('avvisi').insert({ titolo, contenuto })
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['inserimento-senza-sede'])
    })

    it('una RPC senza sede e senza gate', () => {
        const src = `
      export const POST = withRoute('pagamenti/genera:POST', async (request) => {
        const supabase = await createAdminClient()
        await supabase.rpc('genera_rette_mensili', { p_periodo: periodo })
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['rpc-senza-sede'])
    })

    it('una tabella legata all ALUNNO letta senza nessun gate', () => {
        const src = `
      export const GET = withRoute('primaria/valutazioni:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('valutazioni').select('*').eq('alunno_id', body.alunnoId)
      })
    `
        expect(scoperte(src).map((s) => s.motivo)).toEqual(['handler-senza-scope'])
    })

    it('il filtro di sede citato in un COMMENTO non conta', () => {
        const src = `
      export const GET = withRoute('admin/audit:GET', async (request) => {
        const supabase = await createAdminClient()
        // Qui prima mancava \`.in('scuola_id', sedi)\`: la segreteria vedeva tutto.
        const { data } = await supabase.from('audit_scritture_docente').select('id')
      })
    `
        expect(scoperte(src)).toHaveLength(1)
    })
})

describe('il rilevatore NON segnala le forme corrette', () => {
    it('filtro di sede nella stessa catena, su più righe e con commenti in mezzo', () => {
        const src = `
      export const GET = withRoute('admin/audit:GET', async (request) => {
        const supabase = await createAdminClient()
        const sedi = await resolveScuoleAttive(request, supabase, auth.user)
        const { data } = await supabase
          .from('audit_scritture_docente')
          // ristretto ai plessi accessibili
          .select('id')
          .in('scuola_id', sedi)
      })
    `
        expect(scoperte(src)).toEqual([])
    })

    it('continuazione condizionale sulla stessa variabile (PostgREST le mette in AND)', () => {
        const src = `
      export const GET = withRoute('forms/delibera:POST', async (request) => {
        const supabase = await createAdminClient()
        let q = supabase.from('form_submissions').select('id').eq('status', 'completed')
        if (conSede) q = q.in('scuola_id', plessi)
        const { data } = await q
      })
    `
        expect(scoperte(src)).toEqual([])
    })

    it('scrittura agganciata all identità che il gate ha verificato', () => {
        const src = `
      export const PATCH = withRoute('admin/students:PATCH', async (request) => {
        const supabase = await createAdminClient()
        const scopeErr = await assertAlunnoInScope(supabase, auth.user, id)
        if (scopeErr) return scopeErr
        await supabase.from('alunni').update(updates).eq('id', id)
      })
    `
        expect(scoperte(src)).toEqual([])
    })

    it('secondo giro di una lettura in due tempi (id ricavati dalla prima query)', () => {
        const src = `
      export const GET = withRoute('diary/students:GET', async (request) => {
        const supabase = await createAdminClient()
        const plessi = await resolveScuoleAttive(request, supabase, auth.user)
        const { data: alunni } = await supabase.from('alunni').select('id').in('scuola_id', plessi)
        const alunnoIds = (alunni ?? []).map((a) => a.id)
        const { data: presenze } = await supabase.from('presenze').select('*').in('alunno_id', alunnoIds)
      })
    `
        expect(scoperte(src)).toEqual([])
    })

    it('gate di sede scritto a mano (`sedi.includes(riga.scuola_id)`) + scrittura sulla riga letta', () => {
        const src = `
      export const PATCH = withRoute('pagamenti/[id]:PATCH', async (request) => {
        const supabase = await createAdminClient()
        const { data: esistente } = await supabase.from('pagamenti').select('scuola_id').eq('id', id).maybeSingle()
        const sedi = await resolveScuoleAttive(request, supabase, auth.user)
        if (!sedi.includes(String(esistente.scuola_id))) {
          return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
        }
        await supabase.from('pagamenti').update(updates).eq('id', id)
      })
    `
        expect(scoperte(src)).toEqual([])
    })

    it('una tabella che non appartiene a nessuna sede non riguarda questo lock', () => {
        const src = `
      export const GET = withRoute('push/subscribe:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('push_subscriptions').select('*')
      })
    `
        expect(scoperte(src)).toEqual([])
    })
})
