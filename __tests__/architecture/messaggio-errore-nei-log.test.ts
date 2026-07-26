import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock: IL MESSAGGIO DI UN ERRORE NON ENTRA NEL TESTO DI UN LOG.
 *
 * LA STORIA. Appena portati a zero i `console.*` in `src/`, è riemerso lo stesso difetto su un
 * canale peggiore. Una dozzina di componenti definiva in locale
 *
 *     const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
 *
 * e interpolava il risultato dentro `messaggio` di `logClient`. Quel campo non finisce nella
 * console di un telefono: finisce in `app_log.messaggio` — 30 giorni di conservazione,
 * interrogabile in SQL. E `messaggio` è TESTO LIBERO: `@/lib/logging/redact` è una lista bianca
 * PER CHIAVE del contesto strutturato, non guarda dentro una stringa. Su riconciliazione e
 * pagamenti quel `.message` è il testo che il server ha messo in `throw new Error(json.error)`,
 * cioè causali, riferimenti bancari e nomi di famiglie.
 *
 * LA REGOLA. Del `.message` non si prende niente; si prende il `.name` con `nomeErrore()`
 * (`src/lib/logging/client.ts`), che è STRUTTURA e non contenuto — `TypeError` (la rete è giù)
 * contro `Error` (il server ha detto di no) è tutta la distinzione che serve al triage. Il
 * `messaggio` resta uno SLUG stabile che dice quale operazione è fallita.
 *
 * PERCHÉ UN TEST E NON UNA REGOLA ESLINT. La violazione non ha una forma sintattica sola:
 * `testoErrore(err)`, `err.message`, `String(e)`, `(e as Error).message` sono la stessa cosa
 * scritta in quattro modi, e domani ce ne sarà un quinto. Qui si guarda il PUNTO DI ARRIVO —
 * l'argomento di una chiamata al logger — che è invariante.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** Le funzioni di log del progetto: sono loro il punto d'arrivo che questo lock sorveglia. */
const LOGGER = /\b(logClient|logErrore|logEvento|logOk)\s*\(/g;

/**
 * Il modulo del logger è ESENTE, per la stessa ragione per cui `eslint.config.mjs` lo esenta da
 * `no-console`: è il posto in cui la politica viene APPLICATA, non consumata. I suoi due eventi
 * col testo dell'errore (`fetch` fallita, `unhandledrejection`) non hanno un chiamante che possa
 * passare un contesto strutturato — nascono dal browser, non da un componente — e sono l'unica
 * rete che copre le promise che nessuno gestisce.
 */
const ESENTI_PER_MODULO = ['src/lib/logging/'];

/**
 * Le DUE eccezioni puntuali, e il motivo è lo stesso per entrambe.
 *
 * Le boundary React sono l'unico chiamante che spedisce anche `stack`, per contratto di
 * `EventoClient`: e l'header di uno stack V8 *è* il messaggio. Togliere il `.message` dal solo
 * `messaggio` lasciando partire lo stack non nasconderebbe nulla — sarebbe teatro, non privacy.
 * Lì la difesa è un'altra ed è server-side: `/api/logs` passa messaggio e stack per
 * `descriviErrore`, che maschera email e codici fiscali in entrambi. L'errore, inoltre, è un
 * guasto di RENDERING del nostro codice, non l'eco di una risposta del server.
 *
 * Sono verificate vive dal secondo test: un'esenzione che non serve più va tolta, non lasciata
 * lì a coprire il prossimo caso che passa.
 */
const ECCEZIONI: Record<string, string> = {
    'src/app/error.tsx':
        'boundary React di segmento: spedisce anche `stack`, il cui header È il messaggio; la redazione è quella di `descriviErrore` in /api/logs',
    'src/app/global-error.tsx':
        'boundary React del layout radice: idem — `stack` viaggia comunque, e il messaggio distingue in SQL il crash più grave che ci sia',
};

/**
 * Qualcosa che nell'espressione parla di un ERRORE. Serve a non confondere `${e.message}` con
 * `${messaggioChat.message}`: la seconda è una proprietà `message` che non è un errore, e questo
 * lock non ha niente da dirle.
 */
const RIFERIMENTO_ERRORE = /\b(e|ex|err|error|errore|reason|cause|[A-Za-z_$][\w$]*(?:Err|Error|Errore))\b/;

/** Il testo di un errore, in tutte le forme che questo repo ha usato davvero. */
const TESTO_ERRORE: { rx: RegExp; serveRiferimento: boolean }[] = [
    // `err.message`, `(e as Error).message`, `e?.message`
    { rx: /\.\s*message\b/, serveRiferimento: true },
    // `String(e)`, `String(err)` — la scorciatoia con cui `testoErrore` finiva sul ramo non-Error
    { rx: /\bString\s*\(\s*(e|ex|err|error|errore|reason|cause)\b/, serveRiferimento: false },
    // gli helper locali: `testoErrore` era definito identico in 15 file
    { rx: /\b(testoErrore|messaggioErrore|msgErrore|testoDe?ll?Errore|errorMessage|descriviErrore)\s*\(/, serveRiferimento: false },
];

function contieneTestoErrore(espressione: string): boolean {
    return TESTO_ERRORE.some(({ rx, serveRiferimento }) =>
        rx.test(espressione) && (!serveRiferimento || RIFERIMENTO_ERRORE.test(espressione)));
}

function sorgenti(dir = SRC): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) {
            out.push(...sorgenti(assoluto));
            continue;
        }
        if (!/\.tsx?$/.test(voce.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

/**
 * Fine di una stringa fra apici, saltando gli escape. Non è pignoleria da parser: senza,
 * una parentesi dentro un testo (`'chiusura)'`) chiuderebbe la chiamata in anticipo e
 * l'analisi guarderebbe il pezzo sbagliato di file — cioè falsi positivi e falsi negativi
 * insieme, che è il modo più efficace di rendere un lock inutile.
 */
function fineStringa(testo: string, inizio: number, apice: string): number {
    for (let i = inizio + 1; i < testo.length; i++) {
        if (testo[i] === '\\') { i++; continue; }
        if (testo[i] === apice) return i;
        if (testo[i] === '\n' && apice !== '`') return i; // stringa non terminata: si taglia qui
    }
    return testo.length;
}

interface Scansione {
    /** Indice della parentesi/graffa che chiude il blocco. */
    fine: number;
    /** Il testo di ogni `${…}` incontrato, a qualunque profondità di annidamento. */
    interpolazioni: string[];
}

/**
 * Legge un blocco delimitato — `(`, `[` o `{` — restituendo dove finisce e tutte le
 * interpolazioni dei template literal che contiene. Salta stringhe e commenti: un `${…}`
 * dentro un commento non è codice, e un lock che lo segnalasse verrebbe disattivato al primo
 * falso allarme.
 */
function leggiBlocco(testo: string, apertura: number): Scansione {
    const interpolazioni: string[] = [];
    let prof = 0;
    let i = apertura;
    for (; i < testo.length; i++) {
        const c = testo[i];
        if (c === '/' && testo[i + 1] === '/') {
            const nl = testo.indexOf('\n', i);
            i = nl === -1 ? testo.length : nl;
            continue;
        }
        if (c === '/' && testo[i + 1] === '*') {
            const fine = testo.indexOf('*/', i + 2);
            i = fine === -1 ? testo.length : fine + 1;
            continue;
        }
        if (c === "'" || c === '"') { i = fineStringa(testo, i, c); continue; }
        if (c === '`') {
            const t = leggiTemplate(testo, i);
            interpolazioni.push(...t.interpolazioni);
            i = t.fine;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { prof++; continue; }
        if (c === ')' || c === ']' || c === '}') {
            prof--;
            if (prof === 0) break;
        }
    }
    return { fine: i, interpolazioni };
}

/** Un template literal: raccoglie i suoi `${…}` (e quelli dei template annidati dentro). */
function leggiTemplate(testo: string, inizio: number): Scansione {
    const interpolazioni: string[] = [];
    for (let i = inizio + 1; i < testo.length; i++) {
        const c = testo[i];
        if (c === '\\') { i++; continue; }
        if (c === '`') return { fine: i, interpolazioni };
        if (c === '$' && testo[i + 1] === '{') {
            const dentro = leggiBlocco(testo, i + 1);
            interpolazioni.push(testo.slice(i + 2, dentro.fine));
            interpolazioni.push(...dentro.interpolazioni);
            i = dentro.fine;
        }
    }
    return { fine: testo.length, interpolazioni };
}

/**
 * Il valore della proprietà `messaggio:` di un `logClient({…})`, fino alla virgola di primo
 * livello. Serve alla seconda regola: senza, il lock si aggirerebbe togliendo i backtick
 * (`messaggio: testoErrore(err)`), che è la stessa fuga scritta più corta.
 */
function valoriMessaggio(arg: string): string[] {
    const out: string[] = [];
    const chiave = /\bmessaggio\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = chiave.exec(arg)) !== null) {
        let prof = 0;
        let i = m.index + m[0].length;
        const da = i;
        for (; i < arg.length; i++) {
            const c = arg[i];
            if (c === "'" || c === '"') { i = fineStringa(arg, i, c); continue; }
            if (c === '`') { i = leggiTemplate(arg, i).fine; continue; }
            if (c === '(' || c === '[' || c === '{') { prof++; continue; }
            if (c === ')' || c === ']' || c === '}') { if (prof === 0) break; prof--; continue; }
            if (c === ',' && prof === 0) break;
        }
        out.push(arg.slice(da, i));
    }
    return out;
}

interface Rilievo { file: string; riga: number; fn: string; espressione: string }

function rilievi(soloFile?: string): Rilievo[] {
    const trovati: Rilievo[] = [];
    for (const rel of sorgenti()) {
        if (soloFile !== undefined ? rel !== soloFile : ESENTI_PER_MODULO.some((e) => rel.startsWith(e))) continue;
        const testo = fs.readFileSync(path.join(RADICE, rel), 'utf8');
        LOGGER.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LOGGER.exec(testo)) !== null) {
            const apertura = m.index + m[0].length - 1;
            const { fine, interpolazioni } = leggiBlocco(testo, apertura);
            const arg = testo.slice(apertura + 1, fine);
            const riga = testo.slice(0, apertura).split('\n').length;

            const colpevoli = [
                ...interpolazioni.filter(contieneTestoErrore),
                // Il valore diretto conta solo se non è già un template: quello l'ha
                // esaminato la riga sopra, interpolazione per interpolazione.
                ...valoriMessaggio(arg).filter((v) => !v.trim().startsWith('`') && contieneTestoErrore(v)),
            ];
            if (colpevoli.length === 0) continue;
            trovati.push({
                file: rel,
                riga,
                fn: m[1],
                espressione: colpevoli.map((c) => c.replace(/\s+/g, ' ').trim()).join(' · ').slice(0, 120),
            });
        }
    }
    return trovati;
}

const AIUTO = [
    '',
    'Il MESSAGGIO di un errore non può finire nel testo di un log: `app_log.messaggio` vive 30',
    'giorni, si interroga in SQL, e `redact()` è una lista bianca PER CHIAVE — dentro una stringa',
    'non guarda. Su pagamenti e riconciliazione quel `.message` è l\'eco della risposta del server:',
    'causali, riferimenti, nomi di famiglie.',
    '',
    'CLIENT — `nomeErrore(e)` da `@/lib/logging/client` (prende solo il `.name`) e un messaggio-slug',
    'stabile che dica QUALE operazione è fallita:',
    '    logClient({ livello: \'error\', evento: \'fetch\',',
    '        messaggio: `cassa-movimento-salvataggio-fallito: ${nomeErrore(err)}`, route: \'/admin/pagamenti\' })',
    '',
    'SERVER — l\'errore si passa INTERO come argomento, mai riassunto nel testo:',
    '    logErrore({ operazione: \'cassa/movimento:POST\' }, err)   // `descriviErrore` lo sanifica',
    '',
    'Gli IDENTIFICATIVI (uuid) non vanno concatenati nella stringa: nel client il messaggio è anche',
    'la chiave del throttle di `logClient`, e un id dentro il testo la rende diversa per ogni utente',
    '— cioè disattiva la deduplica proprio durante una tempesta.',
].join('\n');

describe('nessun messaggio d\'errore dentro il testo dei log', () => {
    it('nessuna chiamata al logger interpola il .message di un errore', () => {
        const trovati = rilievi().filter((r) => ECCEZIONI[r.file] === undefined);
        const elenco = trovati.map((r) => `  ${r.file}:${r.riga}  ${r.fn}(…)  →  ${r.espressione}`).join('\n');
        expect(trovati, `${trovati.length} punti passano il testo di un errore al logger:\n${elenco}\n${AIUTO}`).toEqual([]);
    });

    it('ogni eccezione dichiarata è ancora viva (altrimenti va tolta)', () => {
        for (const [file, motivo] of Object.entries(ECCEZIONI)) {
            expect(
                fs.existsSync(path.join(RADICE, file)),
                `L'eccezione per ${file} punta a un file che non esiste più: toglila da ECCEZIONI.`,
            ).toBe(true);
            expect(
                rilievi(file).length,
                `${file} non contiene più il pattern (motivo dichiarato: ${motivo}).\n`
                + 'Un\'esenzione che non serve più copre il prossimo caso che passa di lì: toglila da ECCEZIONI.',
            ).toBeGreaterThan(0);
        }
    });
});
