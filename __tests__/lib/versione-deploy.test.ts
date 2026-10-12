import { describe, it, expect, afterEach } from 'vitest';

import { VERSIONE_MAX, shaNormalizzato, versioneDeploy } from '@/lib/versione/deploy';

/**
 * LA VERSIONE DI QUESTO DEPLOY — una sola regola, letta da tre posti.
 *
 * La funzione viveva dentro `src/lib/health/controlli.ts` (`versioneCorrente`) e serviva solo al
 * corpo di `/api/health/vivo`. Dal 2026-10-12 la stessa stringa la leggono anche
 * `GET /api/versione` e, COTTA IN BUILD, il bundle del browser: tre posti che devono dire la
 * STESSA cosa, altrimenti il confronto «la versione servita è diversa da quella che ho in mano»
 * sarebbe vero per sempre e il browser si ricaricherebbe in cerchio.
 *
 * ⚠️ IL VINCOLO CHE NON SI PUÒ ALLENTARE: la risposta è PUBBLICA (`/api/versione` non ha gate), e
 * il valore arriva da una variabile d'ambiente. Una variabile d'ambiente non è un dato nostro: se
 * non ha la forma di uno sha non esce, mai — altrimenti la route rilancerebbe a un anonimo il
 * contenuto arbitrario di `process.env`.
 */

const SHA_PIENO = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const originale = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
    if (originale === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = originale;
});

describe('shaNormalizzato', () => {
    it('taglia a VERSIONE_MAX caratteri e abbassa le maiuscole', () => {
        expect(shaNormalizzato(SHA_PIENO.toUpperCase())).toBe(SHA_PIENO.slice(0, VERSIONE_MAX));
        expect(shaNormalizzato(SHA_PIENO)).toHaveLength(VERSIONE_MAX);
    });

    it('accetta lo sha corto di git (7 caratteri) tale e quale', () => {
        expect(shaNormalizzato('a1b2c3d')).toBe('a1b2c3d');
    });

    it('tollera gli spazi attorno: una variabile d\'ambiente li porta spesso', () => {
        expect(shaNormalizzato(`  ${SHA_PIENO}\n`)).toBe(SHA_PIENO.slice(0, VERSIONE_MAX));
    });

    it('NON fa uscire ciò che non è uno sha', () => {
        // Il caso che conta: la route è pubblica, e questo è il solo filtro fra
        // `process.env` e un anonimo.
        for (const valore of [
            '',
            '   ',
            'a1b2c3',                 // sei caratteri: più corto dello sha corto di git
            'main',
            'z1b2c3d4e5f6',           // `z` non è esadecimale
            'a1b2c3d4-e5f6',
            '<script>alert(1)</script>',
            'a1b2c3d4e5f6 && rm -rf /',
            undefined,
            null,
        ]) {
            expect(shaNormalizzato(valore), `«${String(valore)}» è uscito`).toBeNull();
        }
    });
});

describe('versioneDeploy (lato server)', () => {
    it('legge `VERCEL_GIT_COMMIT_SHA` e la normalizza', () => {
        process.env.VERCEL_GIT_COMMIT_SHA = SHA_PIENO.toUpperCase();
        expect(versioneDeploy()).toBe(SHA_PIENO.slice(0, VERSIONE_MAX));
    });

    it('assente o fuori forma → `null`, non una stringa vuota', () => {
        // `null` e `''` non sono la stessa cosa per chi legge: il client confronta la versione
        // servita con la propria, e una stringa vuota sarebbe «una versione» diversa da tutte.
        delete process.env.VERCEL_GIT_COMMIT_SHA;
        expect(versioneDeploy()).toBeNull();
        process.env.VERCEL_GIT_COMMIT_SHA = 'non-uno-sha';
        expect(versioneDeploy()).toBeNull();
    });
});
