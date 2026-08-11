import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK dei GATE DI AUTENTICAZIONE — per HANDLER e per RAMO.
 *
 * ─── Perché esiste ───────────────────────────────────────────────────────────
 * Il 2026-08-02, col gate formale verde (617 file, 5573 test), due route
 * rispondevano a un ANONIMO su dati di minori:
 *
 *  • `GET /api/admin/primaria/docenti-materie?sectionId=…` → **200**. Apriva con
 *    `parseQuery` e andava dritto a `createAdminClient()`, che è il client
 *    SERVICE-ROLE: la RLS è scavalcata per costruzione. Restituiva nome e cognome
 *    del personale e gli id di sezione di QUALUNQUE classe di QUALUNQUE sede.
 *    POST e DELETE, nello stesso file, avevano `requireStaff` + `assertSezioneInScope`.
 *  • `GET /api/diary?alunno_id=…` → nessun gate affatto. Rispondeva 500 solo
 *    perché la tabella `daily_routines` non esiste in produzione; il giorno in cui
 *    esistesse avrebbe restituito il diario di qualsiasi bambino a chiunque.
 *
 * Il difetto non è «qualcuno ha dimenticato un gate»: è che NIENTE se ne
 * accorgeva. Una route senza gate non fallisce, non si rompe e non avvisa
 * nessuno — risponde 200. È lo stesso identico impianto di
 * `logging-coverage.test.ts` (route nuda = invisibile nei log) applicato al
 * presidio che decide CHI legge i dati di un minore.
 *
 * ─── La regola, e perché non basta «il gate c'è nel file» ────────────────────
 * La granularità è l'EXPORT, come in `logging-coverage`: `admin/primaria/docenti-materie`
 * aveva DUE handler gated e uno nudo nello stesso file, e un lock per file
 * l'avrebbe visto coperto.
 *
 * Ma nemmeno «il gate c'è nell'handler» basta, ed è la ragione per cui questo
 * lock è più severo del necessario in apparenza: `diary:GET` HA un gate —
 * `requireDocente`, dentro il ramo `classe_id` — e il ramo `alunno_id`, subito
 * sotto, non ne ha nessuno. Un lock che cerca un gate «da qualche parte
 * nell'handler» sarebbe stato VERDE sulla seconda delle due falle. Verificato
 * scrivendolo: la prima stesura di questo file trovava 21 candidati e
 * `docenti-materie:GET`, e `diary:GET` non compariva.
 *
 * Perciò la regola è la DOMINANZA, che è il modo esatto di dire ciò che si
 * intende: *ogni accesso ai dati deve essere preceduto da un gate che sta su
 * tutte le strade che ci arrivano*. Un gate dentro un ramo `if` non domina il
 * ramo `else`: sono due strade, e su una non c'è nessuno.
 *
 * ─── Che cos'è un gate, per questo lock ─────────────────────────────────────
 * Una funzione che stabilisce CHI sta chiamando e può negare: i quattro
 * `require*` di `require-staff.ts`, `requireParentOfStudent`, `requireFunzione`,
 * `resolveIdentity`/`loadAppUser` (il gate scritto a mano), `sealDangerous` (in
 * produzione l'handler non gira affatto), il confronto col `CRON_SECRET`,
 * `supabase.auth.getUser()`.
 *
 * NON basta un `assert…InScope`: quello dice QUALI righe, non CHI — e per
 * chiamarlo serve già un `user`. Un handler che avesse solo quello starebbe
 * chiedendo lo scope di un'identità che nessuno ha verificato.
 *
 * I gate scritti in casa si riconoscono dal CORPO e non dal nome, come in
 * `isolamento-sede-coverage.test.ts`: una funzione — di questo file o di
 * `src/lib` — che al suo interno chiama un gate È un gate. Un lock che non li
 * riconosce non è severo: chiede di riscrivere codice corretto, e il primo che
 * lo zittisce con un'allowlist ha ragione lui.
 *
 * Chi non può avere un gate sta in `PUBBLICHE`, con la ragione scritta per
 * esteso. Il tetto può solo SCENDERE (vedi l'ultimo test).
 */

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api')
const LIB_ROOT = path.join(process.cwd(), 'src', 'lib')
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS'

/** `export const GET = withRoute(` — la granularità di questo lock. */
const EXPORT_HANDLER = new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\s*\\(`, 'g')

/**
 * I gate PRIMITIVI: stabiliscono l'identità del chiamante e sanno dire di no.
 * Da qui si deriva tutto il resto (gli helper si riconoscono perché li chiamano).
 */
const GATE_BASE = [
    'requireStaff', 'requireDocente', 'requireUser', 'requireKitchenRead',
    'requireParentOfStudent', 'requireFunzione', 'requireArea',
    'loadAppUser', 'resolveIdentity', 'resolveSessionAppId',
    // In produzione risponde 404 e l'handler non prosegue: è un gate totale.
    'sealDangerous',
    // Legame di famiglia: «questo bambino è tuo figlio» è un'autorizzazione.
    'genitoreHasFiglio',
]

/**
 * Le due forme che un gate può avere senza essere una funzione con un nome:
 * il segreto del cron (service-to-service) e la sessione Supabase letta a mano.
 */
const GATE_SENZA_NOME = String.raw`CRON_SECRET|\bauth\s*\.\s*getUser\s*\(`

function gateRe(nomi: string[]): RegExp {
    return new RegExp(`\\b(?:${nomi.join('|')})\\s*\\(|${GATE_SENZA_NOME}`, 'g')
}

/**
 * L'ACCESSO AI DATI: `.from('tabella')` e `.rpc('funzione')`. È ciò che il gate
 * deve precedere. `supabase.storage.from('bucket')` è compreso di proposito: le
 * foto dei bambini stanno lì, e un bucket letto senza sapere chi chiama è lo
 * stesso difetto con un'altra API.
 */
const ACCESSO = /\.\s*(?:from|rpc)\s*\(/g

/** Indice DOPO la graffa che chiude quella aperta in `apertura`. */
function fineGraffa(strut: string, apertura: number): number {
    let livello = 0
    for (let k = apertura; k < strut.length; k++) {
        if (strut[k] === '{') livello++
        else if (strut[k] === '}') { livello--; if (livello === 0) return k + 1 }
    }
    return strut.length
}

export interface Ramo { da: number; a: number }
/** Una catena `if / else if / … / else`: i suoi rami sono ESCLUSIVI fra loro. */
export type Catena = Ramo[]

/**
 * Le CATENE condizionali dentro `[da, a)`: per ogni `if`, i corpi del ramo
 * positivo, di ogni `else if` e dell'`else`. A QUALSIASI profondità — un `if`
 * dentro un `try` dentro un `if` è comunque una biforcazione, e la falla di
 * `diary:GET` stava esattamente lì (dentro il `try` che avvolge l'handler).
 *
 * Gli `if` senza graffe (`if (auth.response) return auth.response`) non
 * producono rami: sono la forma con cui in questo repo un gate NEGA, e
 * trattarli come biforcazioni spezzerebbe ogni gate del progetto.
 */
export function catene(strut: string, da: number, a: number): Catena[] {
    const out: Catena[] = []
    const re = /\bif\s*\(/g
    re.lastIndex = da
    for (let m = re.exec(strut); m && m.index < a; m = re.exec(strut)) {
        const chiusaCond = fineParentesi(strut, m.index + m[0].length - 1)
        let k = chiusaCond
        while (k < a && /\s/.test(strut[k])) k++
        if (strut[k] !== '{') continue
        const fine = fineGraffa(strut, k)
        const catena: Catena = [{ da: k, a: fine }]
        let j = fine
        while (j < a) {
            while (j < a && /\s/.test(strut[j])) j++
            if (!/^else\b/.test(strut.slice(j, j + 5))) break
            j += 4
            while (j < a && /\s/.test(strut[j])) j++
            if (/^if\s*\(/.test(strut.slice(j, j + 20))) {
                const c2 = fineParentesi(strut, strut.indexOf('(', j))
                let k2 = c2
                while (k2 < a && /\s/.test(strut[k2])) k2++
                if (strut[k2] !== '{') break
                const f2 = fineGraffa(strut, k2)
                catena.push({ da: k2, a: f2 })
                j = f2
            } else if (strut[j] === '{') {
                const f2 = fineGraffa(strut, j)
                catena.push({ da: j, a: f2 })
                j = f2
            } else break
        }
        if (catena.length > 1) out.push(catena)
    }
    return out
}

/**
 * Il gate in `j` COPRE l'accesso in `i`?
 *
 * Due condizioni, e la seconda è tutto il valore di questo lock:
 *
 *  1. il gate viene PRIMA — un `requireStaff` scritto sotto la query non ha
 *     impedito la lettura, l'ha soltanto raccontata;
 *  2. gate e accesso non stanno in due rami ESCLUSIVI della stessa catena
 *     `if/else`. È la forma esatta di `diary:GET`: `requireDocente` nel ramo
 *     `classe_id`, la query nel ramo `alunno_id` — due strade, e su una non c'è
 *     nessuno.
 *
 * ⚠️ IL LIMITE, dichiarato perché non venga scambiato per una garanzia. Due
 * `if` SEPARATI non sono rami esclusivi, quindi
 * `if (a) { gate }` … `if (b) { query }` risulta coperto anche quando `b` può
 * essere vero con `a` falso. È deliberato: l'idioma di questo repo è
 * `if (alunnoId) { requireParentOfStudent }` seguito da
 * `if (alunnoId && mode === 'stock') { query }` (`locker/inventory:GET`), e una
 * regola che pretendesse la dominanza piena lo direbbe scoperto — un falso
 * positivo su codice corretto, cioè il modo più rapido di far mettere a
 * qualcuno un'esenzione e perdere il lock per intero. Provare l'implicazione
 * fra le condizioni vorrebbe dire interpretarle, e un lock non interpreta.
 * Questo lock chiude ciò che ha già morso; per il resto restano i test di
 * rotta.
 */
export function copre(j: number, i: number, catene: Catena[]): boolean {
    if (j >= i) return false
    for (const catena of catene) {
        const ramoGate = catena.findIndex((r) => j >= r.da && j < r.a)
        if (ramoGate < 0) continue
        const ramoAccesso = catena.findIndex((r) => i >= r.da && i < r.a)
        if (ramoAccesso !== ramoGate) return false
    }
    return true
}

/**
 * Le funzioni di un sorgente il cui CORPO chiama un gate: sono gate anch'esse.
 *
 * `caricaPostConScope(request, supabase, user, id)`, `staffAutorizzato(request)`,
 * `risolviGenitore(request)`: mezzo repo è scritto così. Si riconoscono dal
 * corpo, non dal nome — un elenco di nomi da tenere aggiornato a mano è
 * esattamente il tipo di cosa che non viene aggiornata.
 */
export function helperConGate(senzaCommenti: string, strut: string, nomiGate: string[]): string[] {
    const nomi: string[] = []
    const dichiarazioni = [
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g,
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    ]
    const re = gateRe(nomiGate)
    for (const r of dichiarazioni) {
        for (const m of strut.matchAll(r)) {
            const parametri = fineParentesi(strut, m.index + m[0].length - 1)
            // La graffa del CORPO, non quella di un tipo di ritorno:
            // `): Promise<{ user?: AppUser }> {` ne ha due, e la prima è il tipo.
            let graffa = -1
            let angolare = 0
            for (let k = parametri; k < strut.length; k++) {
                const c = strut[k]
                if (c === '<') angolare++
                else if (c === '>') angolare = Math.max(0, angolare - 1)
                else if (c === '{' && angolare === 0) { graffa = k; break }
            }
            if (graffa < 0) continue
            const corpo = senzaCommenti.slice(graffa, fineGraffa(strut, graffa))
            re.lastIndex = 0
            if (re.test(corpo)) nomi.push(m[1])
        }
    }
    return [...new Set(nomi)]
}

/** Gli stessi, ma in `src/lib`: si calcolano UNA volta per la suite. */
function gateDiLibreria(): string[] {
    let trovati: string[] = []
    // Due giri: `requireParentOfStudent` chiama `requireUser`, e un helper che
    // chiama `requireParentOfStudent` è gate solo al secondo passaggio.
    for (let giro = 0; giro < 2; giro++) {
        const acc: string[] = []
        for (const f of fileSorgente(LIB_ROOT)) {
            const { senzaCommenti, struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
            acc.push(...helperConGate(senzaCommenti, struttura, [...GATE_BASE, ...trovati]))
        }
        trovati = [...new Set([...trovati, ...acc])].filter((n) => !GATE_BASE.includes(n))
    }
    return trovati
}

const GATE_LIB = gateDiLibreria()

export interface Scoperto {
    handler: string
    riga: number
    motivo: 'handler-senza-gate' | 'ramo-senza-gate'
}

/** Gli handler di un file di route che accedono ai dati senza un gate che li domini. */
export function scoperti(src: string): Scoperto[] {
    const { senzaCommenti, struttura } = mascheraSorgente(src)
    const locali = helperConGate(senzaCommenti, struttura, [...GATE_BASE, ...GATE_LIB])
    const RE = gateRe([...GATE_BASE, ...GATE_LIB, ...locali])
    const out: Scoperto[] = []

    EXPORT_HANDLER.lastIndex = 0
    for (const m of struttura.matchAll(EXPORT_HANDLER)) {
        const da = m.index
        const a = fineParentesi(struttura, da + m[0].length - 1)

        const gate: number[] = []
        RE.lastIndex = da
        for (let g = RE.exec(senzaCommenti); g && g.index < a; g = RE.exec(senzaCommenti)) gate.push(g.index)

        // ── Regola 1: nessun gate, punto. ───────────────────────────────────
        // Nessuna precondizione «…e tocca i dati»: la query può stare dentro un
        // helper di `src/lib` e da qui non vedersi affatto (`sediReali`,
        // `risolviGenitorePerEmail`). «Non vedo accessi» non è «non ce ne sono»,
        // e un lock che ci si appoggia si spegne da solo il giorno in cui
        // qualcuno sposta una query in una funzione. Un handler che davvero non
        // tocca niente — `push/vapid-public-key` restituisce una costante — è
        // una decisione, e le decisioni stanno in `PUBBLICHE`.
        if (gate.length === 0) {
            out.push({ handler: m[1], riga: riga(src, da), motivo: 'handler-senza-gate' })
            continue
        }

        // ── Regola 2: c'è un gate, ma non su tutte le strade. ────────────────
        const cat = catene(struttura, da, a)
        const accessi: number[] = []
        ACCESSO.lastIndex = da
        for (let q = ACCESSO.exec(senzaCommenti); q && q.index < a; q = ACCESSO.exec(senzaCommenti)) accessi.push(q.index)
        const nudi = accessi.filter((i) => !gate.some((j) => copre(j, i, cat)))
        if (nudi.length === 0) continue
        out.push({ handler: m[1], riga: riga(src, nudi[0]), motivo: 'ramo-senza-gate' })
    }
    return out
}

// ─────────────────────────────────────────────────────────────────────────────
// I file
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

// ─────────────────────────────────────────────────────────────────────────────
// L'ALLOWLIST — a MATCH ESATTO, `<route>:<METODO>`
//
// Non per PREFISSO: `public/` esenterebbe anche le route che nasceranno dopo, e
// una voce vale per UN handler e basta — un `POST` nuovo accanto a un `GET`
// esentato non eredita niente. È la lezione che `isolamento-sede-coverage` ha
// pagato con un audit da 140 rilievi.
//
// Ogni riga è una DECISIONE, non un'eccezione di comodo. Sono quasi tutte
// «pubbliche per progetto»: il gate c'è, solo che non è una sessione — è un
// token, un codice OTP recapitato per email, un ticket firmato HMAC, un tetto
// per IP. Chi ne aggiunge una deve poterla difendere davanti a un genitore.
//
// Verificate una per una il 2026-08-02, aprendo il file: l'elenco NON è stato
// preso per buono da nessuno.
// ─────────────────────────────────────────────────────────────────────────────
const PUBBLICHE: Record<string, string> = {
    // ── Modulo pubblico d'iscrizione: chi compila non ha (ancora) un account ──
    // Il perimetro è il rate-limit per IP + la validazione server-side. È il
    // canale da cui in produzione sono arrivate 227 domande vere.
    'iscrizione:POST': 'modulo pubblico: chi si iscrive non ha un account. Tetto 5 invii/10 min per IP + ri-validazione server-side dei campi contro il modello',
    'iscrizione/sedi:GET': 'modulo pubblico: elenco delle sole sedi reali (id e nome, niente anagrafica), tetto 30/10 min per IP. Il wizard deve poter scegliere il plesso PRIMA di esistere come utente',
    'iscrizione/model:GET': "modulo pubblico: restituisce SOLO lo schema dei campi del modello standard, nessun dato personale",
    'iscrizione/upload:POST': 'modulo pubblico: allegato del wizard di iscrizione, su bucket dedicato con nome randomizzato e tetto di dimensione',
    // ── Modulo pubblico «Lavora con noi»: chi si candida non ha un account ───
    // E non può averlo: l'account (`utenti`, ruolo `educator`) nasce SOLO se la
    // Direzione approva. La migrazione `20260810094610_candidature_insegnanti.sql`
    // spiega perché la candidatura non può vivere in `utenti` con `attivo=false`:
    // `utenti.attivo` non è letto da nessun gate di questa applicazione, quindi una
    // candidata salvata lì avrebbe accesso PIENO all'area docente, e all'anagrafica
    // dei bambini. Un gate qui non è «scomodo»: è impossibile, perché la persona
    // che bussa per definizione non è ancora nessuno.
    //
    // COSA OTTIENE UN ANONIMO CHE PASSA — che è la domanda che distingue questa
    // voce da `forms/send-otp` (vedi il tetto in fondo): può SCRIVERE una riga in
    // `candidature_insegnanti`, e nient'altro. Non legge niente — la sola SELECT
    // dell'handler è quella sulla riga già viva dopo un `23505`, e restituisce un
    // uuid, non un dato. La risposta è `{ id }` e basta: nessuna anagrafica, nessun
    // elenco, nemmeno la conferma che una certa email sia già in valutazione (il
    // doppio invio risponde `201` proprio per non essere un oracolo di
    // enumerazione sul lavoro di qualcuno).
    //
    // IL PERIMETRO, che è quello che resta quando la sessione non c'è: tetto di 3
    // invii l'ora per IP (più stretto dell'iscrizione: le candidature spontanee
    // sono rare), honeypot, ri-validazione server dei campi contro
    // `INSEGNANTE_FIELDS`, gate dei consensi obbligatori, e `scuola_id` accettato
    // solo se compare fra le sedi note — nessun default silenzioso.
    'iscrizione/insegnanti:POST':
        "modulo pubblico «Lavora con noi»: chi si candida non ha un account, e non può averlo — l'account nasce solo se la Direzione approva, e `utenti.attivo` non è letto da nessun gate (vedi la migrazione della tabella). L'anonimo che passa può solo SCRIVERE una candidatura: non legge nulla, la risposta è un id. Perimetro: tetto 3 invii/ora per IP + honeypot + ri-validazione server-side dei campi + consensi obbligatori verificati qui + `scuola_id` valido solo se è una sede nota (nessun default silenzioso)",

    'admin/pre-inscriptions:POST': "sottomissione del portale onboarding pubblico (il GET e il PATCH della stessa route sono `requireStaff`: qui la porta è aperta di proposito, ed è dichiarato nel file). Scrive una riga `pending`, non legge niente",

    // ── Modulistica pubblica: il gate è un TOKEN, non una sessione ───────────
    'public/forms/[token]/submit:POST': 'token pubblico del modello (capability): il modello deve esistere ed essere pubblicato, + tetto 20/10 min per IP',
    'public/forms/[token]/upload:POST': 'token pubblico del modello: allegato accettato solo se il token corrisponde a un modello PUBBLICATO, + tetto 30/10 min per IP',

    // ── Firma elettronica ────────────────────────────────────────────────────
    // QUI C'ERANO DUE VOCI, `forms/send-otp:POST` e `:PATCH`, e la ragione
    // scritta era: «non c'è sessione perché il firmatario può essere il secondo
    // genitore, che un account non ce l'ha». La motivazione era vera e la
    // conclusione sbagliata: giustificava l'assenza di una SESSIONE, ma il
    // codice non la sostituiva con nessuna capability. Il `submissionId` non è
    // un segreto — è l'id che il client del genitore riceve da
    // `/api/parent/forms` — e `signerEmail` arrivava dal body senza alcun
    // confronto con l'anagrafica. Misurato il 2026-08-02: un ANONIMO si faceva
    // recapitare il codice di una firma altrui all'indirizzo che voleva, e poi
    // firmava. Su un documento con valore legale, attribuito alla vittima.
    //
    // Il 2° firmatario senza account continua a firmare: la richiesta la fa il
    // genitore intestatario dalla propria area, e il destinatario si prende dai
    // tutori REGISTRATI dell'alunno. Ciò che è sparito è l'anonimo — quindi le
    // due voci non stanno più qui, e il tetto qui sotto è sceso da 16 a 14.
    'forms/submit:POST': 'compilazione senza firma dal wizard pubblico: tetto 20/10 min per IP + guard server-side sui consensi obbligatori',

    // ── GDPR: la cancellazione si chiede PROPRIO quando non si ha più l'app ───
    'public/cancellazione-account:POST': "richiesta di cancellazione via magic-link: la risposta è SEMPRE identica (anti-enumerazione delle email), nessun dato esce, tetto per IP. Un gate qui renderebbe l'oblio irraggiungibile a chi ha già disinstallato",
    'public/cancellazione-account/conferma:POST': 'conferma della cancellazione: il gate è un ticket firmato HMAC, con scadenza e a uso singolo (anti-replay). L\'email è FIRMATA nel ticket, non arriva dal client',

    // ── Nessun dato da proteggere ───────────────────────────────────────────
    'auth/logout:POST': "uscita: azzera i cookie `kv-active-role` e `sedi_attive`. Non tocca il database e non è un'escalation — chiedere di essere autenticati per potersi disconnettere è un cane che si morde la coda",
    'push/vapid-public-key:GET': 'restituisce la chiave VAPID PUBBLICA da `NEXT_PUBLIC_VAPID_PUBLIC_KEY`: è pubblica per definizione (sta già nel bundle del client)',
    'parent/primaria/note:POST': 'endpoint DEPRECATO (DL-014): risponde 410 e basta. La presa visione è passata alla firma FEA/OTP su `parent/primaria/note/firma`',

    // ── Ingestione dei log del client ────────────────────────────────────────
    'logs:POST': "riceve gli errori del client, che spesso accadono PRIMA del login (un crash sulla schermata di accesso è esattamente ciò che si vuole vedere). L'identità, quando c'è, si deposita nel contesto ma non è richiesta; il perimetro è il tetto per IP + i cap su batch e payload",

    // ── Endpoint di salute ───────────────────────────────────────────────────
    // Un monitor esterno non ha una sessione, e non può averne una: il momento in
    // cui serve di più è proprio quello in cui l'autenticazione è ciò che si è
    // rotto. Un health-check dietro un gate misura il gate, non la salute.
    //
    // Il perimetro è quello che RESTA quando la sessione non c'è: tetto per IP, e
    // soprattutto una risposta che non porta niente da rubare. Il corpo contiene
    // solo nomi di controllo, booleani, millisecondi e — dove serve — un codice
    // d'errore PostgREST. Mai il `message` di un errore (porterebbe fuori nomi di
    // tabelle e vincoli), mai un conteggio di righe reali, mai il valore di una
    // variabile d'ambiente: la voce `config` dice CHE una variabile manca, non
    // quanto vale. C'è un test che lo verifica per ciascuna di queste cose.
    //
    // Quello che un anonimo può dedurre è dunque: se il sistema sta bene, e se un
    // job notturno non gira. È esattamente ciò che deve poter dedurre.
    'health:GET': "endpoint di salute per un monitor esterno, che una sessione non ce l'ha e non può averla: il caso in cui serve di più è quello in cui l'autenticazione è il guasto. Perimetro: tetto per IP + una risposta che non porta dati (nomi di controllo, booleani, ms, al più un codice d'errore — mai messaggi, mai conteggi, mai valori di variabili)",

    // ── Dato APERTO: la tabella dei comuni ───────────────────────────────────
    // La domanda che decide, quella di `health` e non quella di `send-otp`, è
    // «cosa ottiene un anonimo che passa». Qui ottiene l'elenco dei comuni
    // italiani e degli stati esteri con i loro codici catastali: dato pubblico,
    // fermo da anni, che chiunque scarica dall'Agenzia delle Entrate. Nessun dato
    // di famiglie, e nessuna query applicativa: la tabella Belfiore è un file del
    // repo, non una riga di Postgres.
    //
    // ⚠️ Ma «nessun accesso al database» sarebbe falso, e fino al 2026-08-10 questa
    // voce lo diceva: `rateLimit()` — la prima riga dell'handler — apre un
    // `createAdminClient()` (SERVICE ROLE) e fa `rpc('tetto_frequenza_consuma', …)`,
    // cioè una SCRITTURA sul contatore condiviso `public.tetto_frequenza`,
    // provocabile da un anonimo, una per richiesta. È il perimetro stesso, non una
    // svista, ed è comune a tutte le rotte pubbliche di questo elenco; ma chi
    // riaprirà questa voce per decidere se il gate mancante è ancora difendibile
    // deve trovarci il comportamento vero, non una frase più tranquilla di lui.
    //
    // E la chiama un anonimo per costruzione: è la tendina provincia → comune del
    // wizard PUBBLICO d'iscrizione, cioè di chi un account non ce l'ha ancora.
    // Un gate qui non proteggerebbe niente e chiuderebbe il primo passo del modulo
    // da cui arrivano le domande vere.
    //
    // La route esiste perché il dataset (~294 KB, 13.656 righe) NON deve entrare
    // nel bundle del browser — lock `dataset-comuni-fuori-dal-bundle`. Senza questa
    // porta quel divieto sarebbe una privazione, e il primo che ne ha bisogno lo
    // aggira importando la tabella da un componente `'use client'`: compila, passa
    // i test, e ogni famiglia scarica 294 KB dalla rete mobile.
    'anagrafiche/comuni:GET': "tabella Belfiore (comuni italiani e stati esteri): dato APERTO, uguale per tutti, letto da un file del repo — nessun dato di famiglie e nessuna query applicativa. L'unico accesso al database è la scrittura sul contatore del tetto (`rateLimit` → `rpc('tetto_frequenza_consuma')`, client service-role), provocabile da un anonimo una volta per richiesta. La chiama un anonimo dal wizard pubblico d'iscrizione, che un account non ce l'ha ancora. Perimetro: tetto 60/10 min per IP. È anche l'unica risposta del progetto in cache CONDIVISA — e solo per le richieste senza cookie di sessione, perché il middleware può attaccare un `Set-Cookie` alla risposta di una route API (misurato)",
}

function scopertiDelRepo(): { chiave: string; dettaglio: string }[] {
    const out: { chiave: string; dettaglio: string }[] = []
    for (const f of FILES) {
        const src = fs.readFileSync(f, 'utf8')
        for (const s of scoperti(src)) {
            out.push({
                chiave: `${nomeRoute(f)}:${s.handler}`,
                dettaglio: `${path.relative(process.cwd(), f)}:${s.riga} — ${s.motivo}`,
            })
        }
    }
    return out
}

describe('coverage-lock dei gate di autenticazione', () => {
    it('ci sono route e gate da controllare (se cade, il lock si sta autoingannando)', () => {
        // Un lock che gira su zero file, o che non riconosce più nessun gate,
        // passa sempre: è il modo più silenzioso di non controllare niente.
        expect(FILES.length).toBeGreaterThan(200)
        const handler = FILES.reduce((n, f) => {
            const { struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
            EXPORT_HANDLER.lastIndex = 0
            return n + [...struttura.matchAll(EXPORT_HANDLER)].length
        }, 0)
        expect(handler).toBeGreaterThan(400)
        // E i gate primitivi devono esistere DAVVERO con quel nome: se qualcuno
        // rinomina `requireStaff`, questo lock non deve diventare verde perché
        // non trova più niente — deve diventare rosso qui.
        const authSrc = fs.readFileSync(path.join(LIB_ROOT, 'auth', 'require-staff.ts'), 'utf8')
        for (const nome of ['requireStaff', 'requireDocente', 'requireUser', 'resolveIdentity']) {
            expect(authSrc, `${nome} non esiste più: aggiorna GATE_BASE`).toContain(`export async function ${nome}`)
        }
    })

    it('ogni handler API ha un gate di identità, e su TUTTE le strade', () => {
        const fuori = scopertiDelRepo().filter((s) => !(s.chiave in PUBBLICHE))
        expect(
            fuori.map((s) => `${s.chiave}  ←  ${s.dettaglio}`),
            'Handler che arrivano ai dati senza sapere CHI sta chiamando. Aggiungi il gate ' +
            "(`requireStaff`/`requireDocente`/`requireUser`/`requireParentOfStudent`) — oppure, se la " +
            'route è pubblica per progetto, una voce in PUBBLICHE con la ragione scritta per esteso. ' +
            '`ramo-senza-gate` significa che il gate c\'è ma sta in un ALTRO ramo dello stesso `if`: ' +
            "è la forma di `diary:GET`, e da fuori non si distingue da una route protetta.",
        ).toEqual([])
    })

    it("l'allowlist non contiene voci morte (una route corretta o cancellata la lascerebbe indietro)", () => {
        const vive = new Set(scopertiDelRepo().map((s) => s.chiave))
        expect(
            Object.keys(PUBBLICHE).filter((k) => !vive.has(k)),
            "Voci di allowlist che non servono più: l'handler ha preso un gate, o è stato " +
            "cancellato. Vanno tolte, o la prossima route che nasce con quel nome eredita " +
            "un'esenzione che nessuno ha mai deciso per lei.",
        ).toEqual([])
    })

    it("il TETTO dell'allowlist può solo SCENDERE", () => {
        // Una fotografia, non una soglia. Se domani qualcuno aggiunge una voce
        // qui il test diventa rosso e va aggiornato A MANO: è il momento in cui
        // la decisione passa sotto gli occhi di qualcuno. Un lock che si allarga
        // in silenzio non è un lock.
        //
        // 16 il 2026-08-02, alla nascita: sedici handler pubblici PER PROGETTO,
        // verificati uno per uno aprendo il file. I due che NON sono qui dentro
        // sono i due difetti che hanno fatto nascere questo lock —
        // `admin/primaria/docenti-materie:GET` e `diary:GET` — e sono stati
        // corretti, non esentati.
        //
        // 14 dal 2026-08-02 (sera): `forms/send-otp:POST` e `:PATCH` hanno preso
        // il gate. Erano l'esempio esatto del rischio che questa allowlist
        // porta con sé — una motivazione plausibile («il 2° genitore non ha un
        // account») che copriva una porta che nessuno aveva deciso di lasciare
        // aperta. Il tetto scende: è il verso giusto.
        //
        // 15 dal 2026-08-04, ed è una SALITA: `health:GET`. Il commento qui sopra
        // dice «se è salito, fermati», e mi sono fermato — quindi va scritto perché
        // questa passa e la prossima va guardata con lo stesso sospetto.
        //
        // La differenza con `forms/send-otp` non è che la motivazione sia più bella:
        // è che qui non c'è NIENTE DIETRO LA PORTA. `send-otp` era pubblica e
        // arrivava a un'azione con valore legale su dati di una famiglia; `health`
        // è pubblica e arriva a cinque booleani sul sistema. La domanda che
        // distingue i due casi non è «perché non può avere un gate» — a quella si
        // risponde sempre — ma «cosa ottiene un anonimo che passa». Qui: sapere se
        // il sistema sta bene, e se un job notturno non gira. Che è esattamente ciò
        // che deve poter sapere, ed è la ragione per cui l'endpoint esiste.
        //
        // Il test che tiene ferma questa affermazione non sta qui: sta in
        // `__tests__/api/health.test.ts`, dove si verifica che il corpo non porti
        // mai un messaggio d'errore, mai un conteggio di righe reali, mai il valore
        // di una variabile d'ambiente. Se quel giorno la risposta cominciasse a
        // portare dati, questa voce non sarebbe più difendibile.
        //
        // 16 dal 2026-08-10, e di nuovo una SALITA: `anagrafiche/comuni:GET`. Mi sono
        // fermato, come chiede la riga qui sopra, e la domanda l'ho fatta: «cosa
        // ottiene un anonimo che passa?». La risposta è l'elenco dei comuni italiani
        // con i loro codici catastali — dato aperto, pubblicato dall'Agenzia delle
        // Entrate, uguale per chiunque. Nessuna riga che riguardi una famiglia:
        // dietro questa porta non c'è NIENTE da leggere, che è la stessa ragione per
        // cui `health` è passata e `forms/send-otp` no.
        //
        // Con una precisazione che il 2026-08-10 mancava e che va detta perché la
        // frase «nessun `.rpc(`» era, alla lettera, sbagliata: nel corpo dell'handler
        // non c'è, ma `rateLimit()` fa `rpc('tetto_frequenza_consuma', …)` con un
        // client SERVICE ROLE, cioè un anonimo provoca una scrittura sul contatore
        // condiviso a ogni richiesta. Vale per tutte le rotte pubbliche di questo
        // elenco ed è il perimetro stesso; ma «non tocca il database» e «non tocca
        // dati di famiglie» sono due affermazioni diverse, e solo la seconda è vera.
        //
        // La differenza con una voce di comodo è che qui il gate mancante non è
        // dimenticato: è impossibile. La route serve il primo passo del wizard
        // PUBBLICO d'iscrizione, dove chi compila un account non ce l'ha ancora —
        // e da quel modulo, in produzione, sono arrivate le domande vere.
        //
        // Ciò che tiene ferma l'affermazione non sta qui ma in
        // `__tests__/api/anagrafiche-comuni.test.ts`, dove si misura che la risposta
        // contenga SOLO i quattro campi della tabella Belfiore e pesi quanto deve.
        // Il giorno in cui quel corpo cominciasse a portare altro, questa voce non
        // sarebbe più difendibile.
        //
        // 17 dal 2026-08-10, terza SALITA: `iscrizione/insegnanti:POST`, il modulo
        // pubblico «Lavora con noi». Mi sono fermato, e questa volta la risposta alla
        // domanda «cosa ottiene un anonimo che passa?» NON è «niente»: ottiene di
        // SCRIVERE una riga in `candidature_insegnanti`. È quindi la voce più pesante
        // fra queste diciassette dopo `iscrizione:POST`, e va difesa su un piano
        // diverso da `health` e `comuni`.
        //
        // Perché il gate qui non è dimenticato ma IMPOSSIBILE: chi si candida non ha
        // un account, e non può averlo. L'account (`utenti`, ruolo `educator`) nasce
        // solo se la Direzione approva — e non si può nemmeno creare la riga «spenta»
        // in attesa, perché `utenti.attivo` non è letto da NESSUN gate di questa
        // applicazione: una candidata salvata lì avrebbe accesso pieno all'area
        // docente, cioè all'anagrafica dei bambini. Non è un'ipotesi, è ciò che
        // `require-staff.ts` e `profili.ts` fanno oggi, ed è scritto per esteso nella
        // migrazione `20260810094610_candidature_insegnanti.sql`. La tabella separata
        // esiste proprio per questo.
        //
        // Cosa NON ottiene, che è la metà che rende la voce difendibile: non legge
        // niente. La sola SELECT dell'handler è quella sulla riga già viva dopo un
        // `23505`, e restituisce un uuid; la risposta è `{ id }` e nient'altro —
        // nessuna anagrafica, nessun elenco, e nemmeno la conferma che un dato
        // indirizzo sia già in valutazione (il doppio invio risponde `201` come il
        // primo, apposta per non diventare un oracolo di enumerazione sul lavoro di
        // qualcuno). La scrittura, dal canto suo, è la stessa che il prodotto CHIEDE
        // a un anonimo di fare: è il punto della funzionalità.
        //
        // Ciò che tiene ferma questa affermazione non sta qui ma in
        // `__tests__/api/candidature-insegnanti-post.test.ts` (tetto 3/ora, honeypot,
        // ri-validazione server, consensi, sede solo se nota, `503` e mai `201` sul DB
        // non migrato, `201` e mai `409` sul doppione) e in
        // `__tests__/api/candidature-insegnanti-log-senza-pii.test.ts`. Il giorno in
        // cui quella risposta cominciasse a portare dati di qualcuno, o il tetto
        // sparisse, questa voce non sarebbe più difendibile.
        expect(
            Object.keys(PUBBLICHE).length,
            'Il numero di handler senza gate è cambiato. Se è SALITO, fermati: hai appena ' +
            'tolto un pezzo di questo lock, e questo test esiste perché la cosa passi sotto ' +
            'gli occhi di qualcuno invece che in silenzio.',
        ).toBe(17)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda
// più niente, da fuori, sono identici. Questi test tengono ferme le due forme
// che DEVE vedere — sono le due falle vere, ridotte all'osso — e quelle che non
// deve segnalare.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore riconosce la forma vietata', () => {
    it('handler senza nessun gate (era `admin/primaria/docenti-materie:GET`)', () => {
        const src = `
      export const GET = withRoute('admin/primaria/docenti-materie:GET', async (request) => {
        const q = parseQuery(request, getQuerySchema)
        if ('response' in q) return q.response
        const supabase = await createAdminClient()
        const { data } = await supabase.from('utenti_sezioni_materie').select('*').eq('section_id', q.data.sectionId)
        return NextResponse.json({ data })
      })
    `
        expect(scoperti(src)).toEqual([{ handler: 'GET', riga: 2, motivo: 'handler-senza-gate' }])
    })

    it('gate in un ramo, query nel ramo accanto (era `diary:GET`)', () => {
        // La forma su cui il rilevatore ingenuo — «c\'è un gate nell\'handler?» —
        // era VERDE. Se questo test cade, il lock è tornato a non vedere la
        // seconda delle due falle.
        const src = `
      export const GET = withRoute('diary:GET', async (request) => {
        try {
          const { searchParams } = new URL(request.url)
          const supabase = await createClient()
          if (searchParams.get('classe_id')) {
            const auth = await requireDocente(request)
            if (auth.response) return auth.response
            const { data } = await supabase.from('daily_routines').select('*').eq('classe_id', cid)
            return NextResponse.json({ data })
          } else if (searchParams.get('alunno_id')) {
            const { data } = await supabase.from('daily_routines').select('*').eq('alunno_id', aid)
            return NextResponse.json({ data })
          }
        } catch (err) { logErrore({ operazione: 'diary:GET', stato: 500 }, err) }
      })
    `
        expect(scoperti(src)).toEqual([{ handler: 'GET', riga: 12, motivo: 'ramo-senza-gate' }])
    })

    it('il gate SOTTO la query non ha impedito la lettura, l\'ha solo raccontata', () => {
        const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('alunni').select('*')
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        return NextResponse.json({ data })
      })
    `
        expect(scoperti(src).map((s) => s.motivo)).toEqual(['ramo-senza-gate'])
    })

    it('un gate citato in un COMMENTO non è un gate', () => {
        const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        // Qui prima mancava \`requireStaff(request)\`: rispondeva 200 a un anonimo.
        const supabase = await createAdminClient()
        const { data } = await supabase.from('alunni').select('*')
        return NextResponse.json({ data })
      })
    `
        expect(scoperti(src)).toHaveLength(1)
    })

    it('un `assert…InScope` da solo non basta: dice QUALI righe, non CHI', () => {
        const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const supabase = await createAdminClient()
        const err = await assertAlunnoInScope(supabase, utenteDalClient, id)
        if (err) return err
        const { data } = await supabase.from('alunni').select('*').eq('id', id)
        return NextResponse.json({ data })
      })
    `
        expect(scoperti(src).map((s) => s.motivo)).toEqual(['handler-senza-gate'])
    })

    it('un handler gated non copre quello nudo accanto (era lo stesso file)', () => {
        const src = `
      export const POST = withRoute('admin/x:POST', async (request) => {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const supabase = await createAdminClient()
        await supabase.from('utenti_sezioni_materie').insert(record)
      })

      export const GET = withRoute('admin/x:GET', async (request) => {
        const supabase = await createAdminClient()
        const { data } = await supabase.from('utenti_sezioni_materie').select('*')
        return NextResponse.json({ data })
      })
    `
        expect(scoperti(src)).toEqual([{ handler: 'GET', riga: 9, motivo: 'handler-senza-gate' }])
    })
})

describe('il rilevatore NON segnala le forme corrette', () => {
    it('gate in testa, query dopo', () => {
        const src = `
      export const GET = withRoute('admin/x:GET', async (request) => {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const supabase = await createAdminClient()
        const { data } = await supabase.from('alunni').select('*')
      })
    `
        expect(scoperti(src)).toEqual([])
    })

    it('due rami, due gate diversi (la forma corretta di `diary/entries:GET`)', () => {
        const src = `
      export const GET = withRoute('diary/entries:GET', async (request) => {
        const admin = await createAdminClient()
        if (params.get('alunno_id')) {
          const gate = await requireParentOfStudent(request, alunnoId)
          if (gate.response) return gate.response
          const { data } = await admin.from('eventi_diario').select('*').eq('alunno_id', alunnoId)
          return NextResponse.json(data)
        }
        const auth = await requireDocente(request)
        if (auth.response) return auth.response
        const { data } = await admin.from('eventi_diario').select('*')
        return NextResponse.json(data)
      })
    `
        expect(scoperti(src)).toEqual([])
    })

    it('gate in un blocco di guardia, query in un `if` SEPARATO (`locker/inventory:GET`)', () => {
        // Il limite dichiarato di `copre()`: due `if` distinti non sono rami
        // esclusivi. Se questo test diventasse rosso, il lock avrebbe iniziato a
        // segnalare codice corretto — e un lock rumoroso è un lock che qualcuno
        // spegne.
        const src = `
      export const GET = withRoute('locker/inventory:GET', async (request) => {
        const supabase = await createAdminClient()
        if (alunnoId) {
          const auth = await requireParentOfStudent(request, alunnoId)
          if (auth.response) return auth.response
        }
        if (alunnoId && mode === 'stock') {
          const { data } = await supabase.from('armadietto').select('*').eq('alunno_id', alunnoId)
          return NextResponse.json(data)
        }
        return NextResponse.json({ error: 'Missing params' }, { status: 400 })
      })
    `
        expect(scoperti(src)).toEqual([])
    })

    it('gate scritto in casa: un helper del FILE che dentro chiama un gate', () => {
        const src = `
      async function caricaTransazione(request, context) {
        const auth = await requireStaff(request)
        if (auth.response) return { response: auth.response }
        const supabase = await createAdminClient()
        return { supabase }
      }

      export const GET = withRoute('pagamenti/transazioni/[id]/ricevuta:GET', async (request, context) => {
        const r = await caricaTransazione(request, context)
        if (r.response) return r.response
        const { data } = await r.supabase.from('pagamenti_transazioni').select('*')
      })
    `
        expect(scoperti(src)).toEqual([])
    })

    it('il segreto del cron è un gate (service-to-service, nessun utente)', () => {
        const src = `
      export const POST = withRoute('notifiche/promemoria:POST', async (request) => {
        const secret = request.headers.get('x-cron-secret')
        if (!secret || secret !== process.env.CRON_SECRET) {
          return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
        }
        const supabase = await createAdminClient()
        const { data } = await supabase.from('notifiche').select('*')
      })
    `
        expect(scoperti(src)).toEqual([])
    })

    it('`sealDangerous` è un gate: in produzione l\'handler non gira affatto', () => {
        const src = `
      export const POST = withRoute('admin/wipe:POST', async (request) => {
        const sealed = await sealDangerous(request)
        if (sealed) return sealed
        const supabase = await createAdminClient()
        await supabase.from('alunni').delete().neq('id', '')
      })
    `
        expect(scoperti(src)).toEqual([])
    })
})
