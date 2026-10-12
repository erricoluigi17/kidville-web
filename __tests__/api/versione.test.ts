import { describe, it, expect, vi, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }));
vi.mock('@/lib/logging/logger', () => log);

import { GET } from '@/app/api/versione/route';
import { shouldRedirect } from '@/lib/auth/middleware-rules';

/**
 * `GET /api/versione` — «quale rilascio stai servendo?».
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * A CHE SERVE. Un'app aperta sul telefono resta in memoria per giorni: il bundle che un
 * genitore ha in mano può essere di tre deploy fa, e nessuna navigazione dentro una SPA lo
 * sostituisce. Questa route è la domanda che il browser fa quando torna in primo piano dopo
 * molto tempo; il confronto con la versione COTTA nel suo bundle decide se ricaricare.
 *
 * LE TRE COSE CHE QUESTO TEST TIENE FERME, e perché ciascuna può rompersi in silenzio:
 *
 *  1. NON È IN CACHE. Una risposta messa in cache da un intermediario direbbe «la versione
 *     vecchia» a tempo indeterminato: il controllo resterebbe verde mentre l'app serve codice
 *     nuovo, cioè acceso e inutile. `Cache-Control: no-store` è il contratto.
 *  2. NON ESCE NIENTE CHE NON SIA UNO SHA. La route è pubblica — non c'è gate, perché dietro non
 *     c'è niente — e legge una variabile d'ambiente. Senza il filtro di forma rilancerebbe a un
 *     anonimo il contenuto arbitrario di `process.env`.
 *  3. IL MIDDLEWARE NON LA MANDA AL LOGIN. Una route rediretta risponderebbe l'HTML del login
 *     con uno stato 307, il `res.json()` del client fallirebbe e il controllo sarebbe spento
 *     senza un errore da nessuna parte. È lo stesso inciampo già pagato con
 *     `/manifest.webmanifest`.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const originale = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
    if (originale === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = originale;
    vi.clearAllMocks();
});

async function chiama() {
    const res = await GET(new Request('https://app.kidville.it/api/versione'));
    return { res, corpo: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/versione', () => {
    it('risponde con lo sha del deploy, e con nient\'altro', async () => {
        process.env.VERCEL_GIT_COMMIT_SHA = SHA;
        const { res, corpo } = await chiama();

        expect(res.status).toBe(200);
        expect(corpo).toEqual({ versione: SHA.slice(0, 12) });
        // `toEqual` sopra è già una chiusura, ma la si dichiara: il corpo di una porta
        // pubblica non cresce per distrazione.
        expect(Object.keys(corpo)).toEqual(['versione']);
    });

    it('non si mette in cache', async () => {
        process.env.VERCEL_GIT_COMMIT_SHA = SHA;
        const { res } = await chiama();
        expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('variabile assente → `versione: null` (non una stringa vuota, non un errore)', async () => {
        delete process.env.VERCEL_GIT_COMMIT_SHA;
        const { res, corpo } = await chiama();
        expect(res.status).toBe(200);
        expect(corpo).toEqual({ versione: null });
    });

    it('NON rilancia il contenuto di una variabile che non è uno sha', async () => {
        // ROSSO SE: la route restituisce `process.env.VERCEL_GIT_COMMIT_SHA` grezza.
        process.env.VERCEL_GIT_COMMIT_SHA = '<script>alert(1)</script>';
        const { corpo } = await chiama();
        expect(corpo).toEqual({ versione: null });
    });

    it('il middleware non la manda al login (è pubblica per progetto)', () => {
        expect(shouldRedirect('/api/versione', false)).toBe(false);
    });
});
