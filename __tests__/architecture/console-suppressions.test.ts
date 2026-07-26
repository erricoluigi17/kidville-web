import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sul file di soppressioni ESLint.
 *
 * `eslint-suppressions.json` è il difetto che questo repo teme di più, nella sua
 * forma più insidiosa: non rompe niente, non fa fallire il gate, non avvisa
 * nessuno — e cresce in silenzio. Al momento del collaudo conteneva 94
 * violazioni `no-console` su 38 file, e alcune di quelle righe stampavano nei
 * log del telefono errori PostgREST che riecheggiavano `alunno_id`, `stato`,
 * `panic_alert` e il nome file di una foto.
 *
 * Il lock rende il numero MONOTONO DECRESCENTE: si può correggere, non
 * accumulare. Se questo test diventa rosso, la risposta NON è alzare il tetto.
 */

const FILE = path.join(process.cwd(), 'eslint-suppressions.json');

/**
 * Tetto congelato dopo la bonifica dei 6 file «P0» (quelli che girano nel client
 * e stampavano oggetti o errori con dati di minori) e delle 16 violazioni LATO
 * SERVER (51 → 35): quelle finivano nei Runtime Logs di Vercel **non redatte**,
 * e alcune interpolavano identificativi in chiaro nel messaggio (parentId,
 * scuola_id). Può solo scendere.
 */
const TETTO = 35;

/** Cartelle in cui un `console.*` non può MAI tornare. */
const VIETATE = [
    'src/lib/offline/',
    'src/lib/native/',
    'src/lib/media/',
    'src/lib/logging/',
    'src/components/features/gallery/',
    'src/components/features/native/',
];

/** I file bonificati in questo giro: non devono ricomparire. */
const BONIFICATI = [
    'src/lib/offline/syncEngine.ts',
    'src/components/features/gallery/MediaGrid.tsx',
    'src/app/(dashboard)/teacher/gallery/page.tsx',
    'src/components/features/teacher/tasks/useTasks.ts',
    'src/lib/media/processing.ts',
    'src/components/features/admin/ParentDetailPanel.tsx',
];

/**
 * I 12 moduli SERVER bonificati (16 violazioni). Erano i più pericolosi del lotto:
 * girano nelle funzioni Vercel, dove `console.*` scrive nei Runtime Logs SENZA
 * passare da `redact()` — e tre di loro interpolavano un identificativo dentro la
 * template string (`parentId`, `scuola_id`), cioè fuori da qualunque canale
 * strutturato. Ora passano tutti da `@/lib/logging/logger`.
 *
 * Il lock è DOPPIO di proposito: qui si legge il SORGENTE, non
 * `eslint-suppressions.json`. Un `console.*` rimesso in uno di questi file
 * fallirebbe già `npx eslint . --max-warnings 0`, ma chi rigenerasse le
 * soppressioni per «far passare il gate» le farebbe semplicemente ricomparire nel
 * JSON: quel giro qui non funziona, perché il test guarda il codice.
 */
const SERVER_BONIFICATI = [
    'src/lib/anagrafiche/parents.ts',
    'src/lib/aruba/emissione.ts',
    'src/lib/audit/scrittura.ts',
    'src/lib/auth/profili.ts',
    'src/lib/competenze/certificato-store.ts',
    'src/lib/fea/audit.ts',
    'src/lib/merch/notify.ts',
    'src/lib/primaria/fascicolo-rbac.ts',
    'src/lib/primaria/notifiche.ts',
    'src/lib/primaria/pagella-store.ts',
    'src/lib/sidi/client.ts',
    'src/lib/translate/claude.ts',
];

type Soppressioni = Record<string, Record<string, { count: number }>>;

function leggi(): Soppressioni {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Soppressioni;
}

describe('lock — soppressioni ESLint', () => {
    it('il file esiste ancora e non è vuoto', () => {
        // Se diventasse vuoto perché è cambiato il percorso, questo lock
        // resterebbe verde a vuoto. Quando le soppressioni finiscono davvero, si
        // cancella il file E questo test insieme.
        expect(fs.existsSync(FILE)).toBe(true);
        expect(Object.keys(leggi()).length).toBeGreaterThan(0);
    });

    it(`le soppressioni possono solo CALARE (tetto ${TETTO})`, () => {
        const totale = Object.values(leggi())
            .flatMap((r) => Object.values(r))
            .reduce((s, v) => s + (v.count ?? 0), 0);
        expect(
            totale,
            `Se questo è rosso hai aggiunto un console.* invece di correggerlo. ` +
                `Usa @/lib/logging/logger (server) o @/lib/logging/client (browser). ` +
                `Non alzare il tetto: rigenera con "npx eslint . --prune-suppressions".`,
        ).toBeLessThanOrEqual(TETTO);
    });

    it('l’unica regola sopprimibile è no-console', () => {
        // Impedisce che domani ci si nasconda dentro un'altra regola.
        for (const regole of Object.values(leggi())) {
            expect(Object.keys(regole)).toEqual(['no-console']);
        }
    });

    it('nessuna soppressione nelle cartelle vietate', () => {
        for (const file of Object.keys(leggi())) {
            for (const vietata of VIETATE) {
                expect(file.startsWith(vietata), `${file} è in una cartella vietata`).toBe(false);
            }
        }
    });

    it('i file bonificati non tornano indietro', () => {
        const presenti = Object.keys(leggi());
        for (const f of [...BONIFICATI, ...SERVER_BONIFICATI]) expect(presenti).not.toContain(f);
    });

    it('i moduli server bonificati non chiamano più console', () => {
        for (const f of SERVER_BONIFICATI) {
            const sorgente = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
            const righe = sorgente
                .split('\n')
                .map((riga, i) => ({ n: i + 1, riga }))
                .filter(({ riga }) => {
                    // Si cerca la CHIAMATA (`console.qualcosa(`), non la parola: quei file
                    // spiegano nei commenti perché il `console.*` è stato tolto, e un test
                    // che vietasse anche di NOMINARLO punirebbe la documentazione.
                    const trovato = riga.search(/\bconsole\s*\.\s*\w+\s*\(/);
                    if (trovato === -1) return false;
                    const prima = riga.slice(0, trovato);
                    // Fuori dai commenti (`//`, `/* … */`, riga JSDoc che apre con `*`).
                    return !prima.includes('//') && !prima.includes('/*') && !/^\s*\*/.test(riga);
                });
            expect(
                righe.map(({ n, riga }) => `${f}:${n} ${riga.trim()}`),
                `${f} è un modulo SERVER: un console.* qui finisce nei Runtime Logs di Vercel ` +
                    `NON redatto. Usa logOk/logErrore/logEvento da @/lib/logging/logger e passa ` +
                    `gli identificativi nel contesto strutturato, mai dentro il messaggio.`,
            ).toEqual([]);
        }
    });
});
