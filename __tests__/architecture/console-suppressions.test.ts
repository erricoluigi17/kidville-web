import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sulle soppressioni ESLint — ora nella sua forma finale: ZERO.
 *
 * LA STORIA. `eslint-suppressions.json` è il difetto che questo repo teme di più nella sua
 * forma più insidiosa: non rompe niente, non fa fallire il gate, non avvisa nessuno — e cresce
 * in silenzio. Al collaudo conteneva 94 violazioni `no-console` su 38 file. Alcune di quelle
 * righe stampavano, nella console del telefono di un genitore o di una docente, errori
 * PostgREST che riecheggiavano `alunno_id`, `stato`, `panic_alert` e il nome file di una foto;
 * una interpolava perfino il nome di una classe dentro la stringa.
 *
 * Il lock è nato come tetto MONOTONO DECRESCENTE (94 → 51 → 35) per rendere impossibile
 * accumulare. Le 35 rimaste erano tutte lato CLIENT ed erano le più serie: `console` nel
 * browser non passa da `redact()`, e quei log finiscono in un posto che nessuno di noi leggerà
 * mai e da cui chiunque abbia il telefono in mano può leggere. Ora sono zero, e il file di
 * soppressioni non esiste più.
 *
 * PERCHÉ QUESTO TEST RESTA, ora che ESLint da solo sarebbe rosso. Perché ESLint da solo si
 * zittisce: `npx eslint . --suppress-all` ricrea il file e riporta il gate al verde senza
 * cambiare una riga di codice. Questo test guarda il SORGENTE e l'ASSENZA del file: quel giro
 * qui non funziona. È il doppio lock — la lezione che ha lasciato il collaudo.
 */

const RADICE = process.cwd();
const SOPPRESSIONI = path.join(RADICE, 'eslint-suppressions.json');
const SRC = path.join(RADICE, 'src');

/**
 * Le UNICHE quattro eccezioni, identiche a quelle di `eslint.config.mjs` — e ognuna ha una
 * ragione che non vale per le altre:
 *  · `src/lib/logging/**` È il logger: è il solo posto autorizzato a scrivere su console,
 *    perché è il posto in cui la redazione e il contesto vengono applicati;
 *  · `src/middleware.ts` gira su EDGE, dove il logger (`node:async_hooks`, `node:crypto`) non
 *    è caricabile: lì la riga logfmt si scrive a mano;
 *  · `src/instrumentation*.ts` è la RETE DI SICUREZZA — deve poter parlare anche quando è il
 *    logger stesso a essere rotto.
 *
 * Se questa lista si allunga, la sta allungando qualcuno che vuole scrivere su console: è
 * quello il momento di chiedere perché, non dopo.
 */
const ESENTI = [
    'src/lib/logging/',
    'src/instrumentation.ts',
    'src/instrumentation-client.ts',
    'src/middleware.ts',
];

/**
 * Le cartelle in cui un `console.*` non è «una svista», è un incidente: ci passano foto dei
 * bambini, code offline con i loro nomi, payload della galleria. Sono già coperte dalla
 * regola generale qui sotto — restano nominate perché il messaggio d'errore dica *perché*.
 */
const VIETATE = [
    'src/lib/offline/',
    'src/lib/native/',
    'src/lib/media/',
    'src/components/features/gallery/',
    'src/components/features/native/',
];

function esente(rel: string): boolean {
    return ESENTI.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));
}

/** Tutti i sorgenti applicativi di `src/`, in path relativi con separatore `/`. */
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
 * Le righe di un file che CHIAMANO `console`. Si cerca la chiamata (`console.qualcosa(`), non
 * la parola: i file bonificati spiegano nei commenti perché il `console.*` è stato tolto, e un
 * test che vietasse anche di NOMINARLO punirebbe la documentazione.
 */
function chiamateConsole(rel: string): string[] {
    const sorgente = fs.readFileSync(path.join(RADICE, rel), 'utf8');
    return sorgente
        .split('\n')
        .map((riga, i) => ({ n: i + 1, riga }))
        .filter(({ riga }) => {
            const trovato = riga.search(/\bconsole\s*\.\s*\w+\s*\(/);
            if (trovato === -1) return false;
            const prima = riga.slice(0, trovato);
            // Fuori dai commenti (`//`, `/* … */`, riga JSDoc che apre con `*`).
            return !prima.includes('//') && !prima.includes('/*') && !/^\s*\*/.test(riga);
        })
        .map(({ n, riga }) => `${rel}:${n} ${riga.trim()}`);
}

describe('lock — soppressioni ESLint', () => {
    it('il file di soppressioni non esiste più (e non deve tornare)', () => {
        expect(
            fs.existsSync(SOPPRESSIONI),
            'eslint-suppressions.json è tornato. Non è mai la risposta giusta: ricrearlo ' +
                'riporta il gate al verde senza correggere niente, che è esattamente come le ' +
                '94 violazioni iniziali erano riuscite a restare invisibili. Correggi il ' +
                'console.*, non nasconderlo.',
        ).toBe(false);
    });

    it('nessun `console.*` in src/, fuori dalle quattro eccezioni della config', () => {
        const colpevoli = sorgenti()
            .filter((f) => !esente(f))
            .flatMap((f) => chiamateConsole(f));

        expect(
            colpevoli,
            'Un `console.*` in src/ è un BYPASS dell’osservabilità: salta redact() (e qui i ' +
                'dati sono di minori), salta il contesto della richiesta, e non arriva mai in ' +
                '`app_log`. Usa `@/lib/logging/logger` (server: logOk/logErrore/logEvento) o ' +
                '`@/lib/logging/client` (browser: logClient + nomeErrore). Gli identificativi ' +
                'vanno nel contesto strutturato, MAI dentro la stringa del messaggio.',
        ).toEqual([]);
    });

    it('le cartelle dei dati dei bambini restano pulite', () => {
        // Ridondante rispetto al test sopra, e di proposito: se domani qualcuno allargasse
        // `ESENTI`, questo resterebbe rosso — e con un messaggio che dice cosa c'è in ballo.
        const colpevoli = sorgenti()
            .filter((f) => VIETATE.some((v) => f.startsWith(v)))
            .flatMap((f) => chiamateConsole(f));

        expect(
            colpevoli,
            'Qui passano foto dei bambini, code offline coi loro nomi e payload della ' +
                'galleria: un console.* stampa quella roba in chiaro sul telefono.',
        ).toEqual([]);
    });
});
