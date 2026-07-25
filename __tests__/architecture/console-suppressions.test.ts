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
 * e stampavano oggetti o errori con dati di minori). Può solo scendere.
 */
const TETTO = 51;

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
        for (const f of BONIFICATI) expect(presenti).not.toContain(f);
    });
});
