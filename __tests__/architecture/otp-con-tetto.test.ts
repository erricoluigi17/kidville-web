import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coverage-lock: OGNI handler HTTP che manipola un OTP ha un tetto di frequenza.
 *
 * ─── PERCHÉ UN LOCK E NON UN ELENCO ─────────────────────────────────────────
 *
 * Fino al 2026-08-01 la copertura del tetto OTP era scritta in un test che
 * elencava le rotte PER NOME (`__tests__/api/otp-rate-limit.test.ts`, la costante
 * `INVIO`). Un elenco per nome dimostra soltanto ciò che qualcuno si è ricordato
 * di elencare: la quinta rotta OTP che nascerà domani non comparirà in nessun
 * elenco, non romperà nessun test e non avviserà nessuno — esattamente come è
 * successo alle tre rotte di VERIFICA (`presenze/giustifica`,
 * `primaria/note/firma`, `primaria/pagella/firma`), che sono rimaste senza tetto
 * mentre il test dichiarava «le quattro rotte OTP del genitore hanno un
 * limitatore» e passava.
 *
 * Qui non c'è nessun elenco di ciò che è coperto: si PARTE da tutte le
 * `route.ts` sotto `src/app/api`, si riconosce chi tocca un OTP e si pretende il
 * tetto. Le uniche righe scritte a mano sono le ECCEZIONI, che vanno motivate.
 *
 * ─── COSA DIFENDE IL TETTO, PRECISAMENTE ────────────────────────────────────
 *
 *  · INVIO: una CASELLA EMAIL. Senza tetto, un ciclo di richieste la riempie di
 *    codici a spese della reputazione del dominio mittente.
 *  · VERIFICA: una FIRMA CON VALORE LEGALE. I codici di questo repo sono di SEI
 *    cifre (`otp-ticket.ts` e `forms/send-otp/route.ts`: `randomInt(0, 1_000_000)`)
 *    e un confronto fallito non consuma il ticket. Senza tetto i tentativi sono
 *    illimitati e gratuiti: un milione di possibilità è una serata di lavoro, e
 *    ciò che si ottiene indovinando è la presa visione di una nota, di una
 *    pagella o la giustificazione di un'assenza a nome di un genitore vero.
 *
 * ─── GRANULARITÀ: IL SINGOLO HANDLER, NON IL FILE ───────────────────────────
 *
 * Si controlla ogni `export const <METODO> = …` separatamente, e non il file
 * intero, perché `forms/send-otp/route.ts` è la dimostrazione vivente che un
 * controllo per file mente: il suo POST ha un `rateLimit` per IP, il suo PATCH —
 * che è quello che CONFRONTA il codice a sei cifre — non ha niente. Un lock che
 * avesse letto il file avrebbe visto `rateLimit(` e sarebbe passato.
 *
 * ─── COSA QUESTO LOCK NON PUÒ VEDERE (detto, non nascosto) ──────────────────
 *
 * Il riconoscimento è testuale: cerca le due famiglie di OTP che questo repo ha
 * davvero (il ticket HMAC di `@/lib/auth/otp-ticket` e l'hash su
 * `form_submissions.otp_secret`). Chi scrivesse domani una TERZA implementazione
 * di OTP, con nomi tutti suoi, sfuggirebbe. Non è un difetto che si possa
 * chiudere con una regex più furba: è il limite di qualunque analisi statica su
 * un concetto («questo è un OTP») che non ha un tipo. La difesa che resta è
 * l'assunto d'inventario qui sotto — se un giorno i segnali smettono di trovare
 * gli undici handler noti, vuol dire che l'implementazione è cambiata sotto i
 * piedi del lock, e il lock lo dice invece di diventare cieco in silenzio.
 */

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const EXPORT_HTTP = new RegExp(`export\\s+const\\s+(${METODI})\\s*=`, 'g');

/** Il blocco di codice VERIFICA un codice OTP. */
const SEGNALI_VERIFICA: RegExp[] = [
    // Famiglia 1 — ticket HMAC (`@/lib/auth/otp-ticket`): il codice a sei cifre è
    // l'unico ingrediente segreto che il client non ha già in mano.
    /\bverifyTicket\s*\(/,
    // Famiglia 2 — hash in tabella (`form_submissions.otp_secret`, `forms/send-otp`).
    /\botp_secret\b/,
];

/** Il blocco di codice SPEDISCE un codice OTP verso una casella. */
const SEGNALI_INVIO: RegExp[] = [
    /\bsendOtp\s*\(/,
    /randomInt\(\s*0\s*,\s*1_?000_?000\s*\)/,
];

/** Un tetto di frequenza, in una qualunque delle sue forme. */
const SEGNALI_TETTO: RegExp[] = [
    /\blimitaVerificaOtp\s*\(/,
    /\blimitaInvioOtp\s*\(/,
    /\brateLimit\s*\(/,
];

/**
 * Handler senza tetto PER SCELTA, con la ragione scritta.
 *
 * Ogni riga qui dentro va difesa a voce alta: è la sola via per cui un OTP senza
 * limite può passare questo lock.
 */
const SENZA_TETTO_GIUSTIFICATE: Record<string, string> = {
    'public/cancellazione-account/conferma:POST':
        'Il `code` di questo flusso NON è un OTP a sei cifre: è un nonce da 128 bit ' +
        '(`creaTicketCancellazione` → `randomBytes(16)`) che viaggia dentro il magic-link ' +
        'spedito alla casella. Non c’è nessuno spazio di un milione da esaurire, e chi non ' +
        'ha ricevuto l’email non possiede nemmeno il ticket con cui tentare. Il lato INVIO ' +
        'di quel flusso (`public/cancellazione-account:POST`) è comunque limitato per IP ' +
        '(5/10min). Il presupposto è verificato più sotto: se un giorno quel codice tornasse ' +
        'a sei cifre, questa eccezione cade e il lock torna rosso.',
};

/**
 * Handler senza tetto e SENZA una buona ragione: buchi noti, ancora aperti.
 *
 * NON è una lista di comodo. È il registro di ciò che si sa e non si è ancora
 * chiuso, e l'assunto qui sotto la fa restringere e mai allargare: quando uno di
 * questi riceve il suo tetto il test diventa ROSSO finché non se ne cancella la
 * riga. Un buco tappato che resta scritto qui sarebbe una bugia in senso opposto,
 * e ne renderebbe l'elenco inutile.
 */
const SENZA_TETTO_DA_CHIUDERE: Record<string, string> = {
    'forms/send-otp:PATCH':
        'VERIFICA un codice a SEI cifre (`hashOtp(submissionId, code) !== submission.otp_secret`) ' +
        'e non ha nessun tetto: il POST della stessa route ne ha uno (IP, 8/10min), il PATCH no. ' +
        'Peggio: non c’è nemmeno un gate d’identità — bastano un `submissionId` e un codice, quindi ' +
        'i tentativi non sono nemmeno attribuibili a una sessione. È il modulo «Sistema A». ' +
        'FUORI dal perimetro esclusivo dello step S30 (2026-08-01), che copriva le quattro rotte ' +
        'OTP del genitore: segnalato allo scrittore-di-piani invece di essere toccato di nascosto ' +
        'mentre altri esecutori lavoravano in parallelo sugli stessi file.',
};

interface Handler {
    /** `parent/forms/otp:PATCH` */
    nome: string;
    /** Il testo del solo corpo di questo export, fino all'export successivo. */
    corpo: string;
}

function routeFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...routeFiles(full));
        else if (e.name === 'route.ts') out.push(full);
    }
    return out;
}

/** Spezza una route.ts nei suoi handler HTTP. Il preambolo (helper, schemi) è escluso di proposito. */
function handlers(file: string): Handler[] {
    const src = fs.readFileSync(file, 'utf8');
    const gruppo = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');
    const tagli = [...src.matchAll(EXPORT_HTTP)].map((m) => ({ metodo: m[1], inizio: m.index ?? 0 }));
    return tagli.map((t, i) => ({
        nome: `${gruppo}:${t.metodo}`,
        corpo: src.slice(t.inizio, tagli[i + 1]?.inizio ?? src.length),
    }));
}

const trova = (corpo: string, segnali: RegExp[]): boolean => segnali.some((re) => re.test(corpo));

const FILES = routeFiles(API_ROOT);
const HANDLERS = FILES.flatMap(handlers);
const VERIFICANO = HANDLERS.filter((h) => trova(h.corpo, SEGNALI_VERIFICA));
const SPEDISCONO = HANDLERS.filter((h) => trova(h.corpo, SEGNALI_INVIO));
const CON_OTP = [...new Set([...VERIFICANO, ...SPEDISCONO])];

/**
 * Gli handler OTP che questo repo ha oggi. È un PAVIMENTO, non un elenco chiuso:
 * una rotta OTP nuova e col tetto non deve rompere niente, ma se i segnali
 * smettono di trovare QUESTI il riconoscimento si è rotto e i test qui sotto
 * sarebbero verdi per il motivo peggiore — non aver guardato niente.
 */
const INVENTARIO_NOTO = [
    'forms/send-otp:POST',
    'forms/send-otp:PATCH',
    'parent/forms/otp:POST',
    'parent/forms/otp:PATCH',
    'parent/presenze/giustifica/otp:POST',
    'parent/presenze/giustifica:POST',
    'parent/primaria/note/firma/otp:POST',
    'parent/primaria/note/firma:POST',
    'parent/primaria/pagella/firma/otp:POST',
    'parent/primaria/pagella/firma:POST',
    'public/cancellazione-account/conferma:POST',
];

describe('lock — ogni OTP ha il suo tetto', () => {
    it('il riconoscimento vede ancora tutte le route (se cade, il lock si sta autoingannando)', () => {
        expect(FILES.length, 'nessuna route.ts trovata: path sbagliato?').toBeGreaterThan(200);
        const nomi = new Set(CON_OTP.map((h) => h.nome));
        const persi = INVENTARIO_NOTO.filter((n) => !nomi.has(n));
        expect(persi, 'handler OTP noti che i segnali non riconoscono più').toEqual([]);
    });

    it('ogni handler che VERIFICA un OTP ha un tetto sui tentativi', () => {
        const nudi = VERIFICANO.filter((h) => !trova(h.corpo, SEGNALI_TETTO))
            .map((h) => h.nome)
            .filter((n) => !(n in SENZA_TETTO_GIUSTIFICATE) && !(n in SENZA_TETTO_DA_CHIUDERE));
        expect(nudi, 'un codice a sei cifre si indovina: questi handler non contano i tentativi').toEqual([]);
    });

    it('ogni handler che SPEDISCE un OTP ha un tetto sugli invii', () => {
        const nudi = SPEDISCONO.filter((h) => !trova(h.corpo, SEGNALI_TETTO))
            .map((h) => h.nome)
            .filter((n) => !(n in SENZA_TETTO_GIUSTIFICATE) && !(n in SENZA_TETTO_DA_CHIUDERE));
        expect(nudi, 'handler che possono riempire di codici la casella di un genitore').toEqual([]);
    });

    it('chi usa il ticket HMAC passa dai DUE helper condivisi, non da un tetto fatto in casa', () => {
        // «Un solo modo di limitare». Quattro `rateLimit(...)` scritti a mano con quattro chiavi
        // diverse sarebbero quattro budget indipendenti: il tetto che si annulla da sé, più il
        // giorno in cui uno dei quattro viene aggiornato e gli altri tre no.
        const sbagliati: string[] = [];
        for (const h of CON_OTP) {
            if (h.nome in SENZA_TETTO_GIUSTIFICATE || h.nome in SENZA_TETTO_DA_CHIUDERE) continue;
            if (/\bverifyTicket\s*\(/.test(h.corpo) && !/\blimitaVerificaOtp\s*\(/.test(h.corpo)) {
                sbagliati.push(`${h.nome} verifica un ticket ma non chiama limitaVerificaOtp()`);
            }
            if (/\bsendOtp\s*\(/.test(h.corpo) && !/\blimitaInvioOtp\s*\(/.test(h.corpo)) {
                sbagliati.push(`${h.nome} spedisce un OTP ma non chiama limitaInvioOtp()`);
            }
        }
        expect(sbagliati, 'tetti OTP fuori da @/lib/security/otp-rate-limit').toEqual([]);
    });

    it('le eccezioni GIUSTIFICATE esistono ancora e il loro presupposto regge', () => {
        const nomi = new Set(CON_OTP.map((h) => h.nome));
        for (const nome of Object.keys(SENZA_TETTO_GIUSTIFICATE)) {
            expect(nomi.has(nome), `eccezione stantia: ${nome} non è più un handler OTP`).toBe(true);
        }
        // Il presupposto dell'unica eccezione: il codice della cancellazione pubblica è un
        // nonce ad alta entropia, non un OTP da digitare. Se tornasse a sei cifre l'eccezione
        // sarebbe falsa, e questo è il punto in cui ce ne accorgiamo.
        const pubblica = fs.readFileSync(
            path.join(process.cwd(), 'src', 'lib', 'gdpr', 'cancellazione-pubblica.ts'),
            'utf8',
        );
        expect(pubblica, 'il code della cancellazione pubblica non è più un nonce casuale').toMatch(
            /const code = randomBytes\(\s*16\s*\)/,
        );
        expect(pubblica, 'la cancellazione pubblica genera un codice a sei cifre: l’eccezione non vale più').not.toMatch(
            /randomInt\(\s*0\s*,\s*1_?000_?000\s*\)/,
        );
    });

    it('i buchi DA CHIUDERE si restringono e non si allargano', () => {
        // Il senso di questo assunto: quando uno di questi riceve il suo tetto, il test diventa
        // rosso finché non se ne cancella la riga. Un registro dei buchi che non si accorge di
        // quando un buco è stato tappato smette di essere un registro e diventa un alibi.
        const perNome = new Map(CON_OTP.map((h) => [h.nome, h] as const));
        for (const nome of Object.keys(SENZA_TETTO_DA_CHIUDERE)) {
            const h = perNome.get(nome);
            expect(h, `${nome} non è più un handler OTP: togli la riga da SENZA_TETTO_DA_CHIUDERE`).toBeDefined();
            expect(
                trova(h!.corpo, SEGNALI_TETTO),
                `${nome} ORA ha un tetto: togli la riga da SENZA_TETTO_DA_CHIUDERE`,
            ).toBe(false);
        }
    });
});
