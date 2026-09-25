import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `ritiraCambioAppelloInCoda` — il pezzo dell'«Annulla» dell'appello primaria che
 * toglie dalla coda offline il cambio ancora da spedire (compito A4).
 *
 * Si ritirano SOLO le righe che il flush ripescherebbe (`pending`, `error`): una
 * `synced` è già sul server e la annulla la DELETE, una `scartato` non riparte mai.
 * Lo store finto legge e cancella davvero per chiave: senza, il test misurerebbe
 * le proprie asserzioni.
 */

const h = vi.hoisted(() => ({
    righe: new Map<string, { id: string; sync_status: string; stato?: string }>(),
    rotto: false,
    scritturaRotta: false,
    logClient: vi.fn(),
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('@/lib/offline/db', () => ({
    db: {
        primaria_appello: {
            get: vi.fn(async (id: string) => {
                if (h.rotto) throw new TypeError('store chiuso');
                return h.righe.get(id);
            }),
            delete: vi.fn(async (id: string) => { h.righe.delete(id); }),
            put: vi.fn(async (r: { id: string; sync_status: string }) => {
                if (h.scritturaRotta) throw new RangeError('quota');
                h.righe.set(r.id, r);
            }),
        },
    },
}));

import { ritiraCambioAppelloInCoda, rimettiCambioAppelloInCoda } from '@/lib/offline/coda-appello-primaria';
import type { LocalPrimariaAppello } from '@/lib/offline/db';

const ALUNNO = 'aaaa1111-0000-4000-8000-000000000001';
const ALTRO = 'bbbb2222-0000-4000-8000-000000000002';
const DATA = '2026-09-24';

beforeEach(() => {
    h.righe.clear();
    h.rotto = false;
    h.scritturaRotta = false;
    vi.clearAllMocks();
});

describe('ritiraCambioAppelloInCoda', () => {
    it.each(['pending', 'error'])('una riga `%s` di quell\'alunno e quel giorno si ritira', async (stato) => {
        const inCoda = { id: `${ALUNNO}|${DATA}`, sync_status: stato, stato: 'ritardo' };
        h.righe.set(inCoda.id, inCoda);
        // Restituisce la riga ritirata: se la DELETE fallisce, il chiamante la rimette.
        await expect(ritiraCambioAppelloInCoda(ALUNNO, DATA)).resolves.toEqual({ esito: 'ritirato', riga: inCoda });
        expect(h.righe.has(`${ALUNNO}|${DATA}`)).toBe(false);
    });

    it.each(['synced', 'scartato'])('una riga `%s` resta dov\'è: non ripartirebbe comunque', async (stato) => {
        h.righe.set(`${ALUNNO}|${DATA}`, { id: `${ALUNNO}|${DATA}`, sync_status: stato });
        await expect(ritiraCambioAppelloInCoda(ALUNNO, DATA)).resolves.toEqual({ esito: 'niente-in-coda' });
        expect(h.righe.has(`${ALUNNO}|${DATA}`)).toBe(true);
    });

    it('non tocca un altro alunno né un altro giorno', async () => {
        h.righe.set(`${ALTRO}|${DATA}`, { id: `${ALTRO}|${DATA}`, sync_status: 'pending' });
        h.righe.set(`${ALUNNO}|2026-09-23`, { id: `${ALUNNO}|2026-09-23`, sync_status: 'pending' });
        await expect(ritiraCambioAppelloInCoda(ALUNNO, DATA)).resolves.toEqual({ esito: 'niente-in-coda' });
        expect(h.righe.size).toBe(2);
    });

    it('coda illeggibile: non lancia, lo dice, e logga `warn` col solo nome dell\'errore', async () => {
        h.rotto = true;
        await expect(ritiraCambioAppelloInCoda(ALUNNO, DATA)).resolves.toEqual({ esito: 'illeggibile' });
        expect(h.logClient).toHaveBeenCalledTimes(1);
        const arg = h.logClient.mock.calls[0][0] as { livello: string; messaggio: string };
        expect(arg.livello).toBe('warn');
        expect(arg.messaggio).toBe('appello-primaria-coda-non-letta-prima-di-annullare: TypeError');
        // Né l'alunno né la data entrano nel log.
        expect(JSON.stringify(arg)).not.toContain(ALUNNO);
        expect(JSON.stringify(arg)).not.toContain(DATA);
    });
});

describe('rimettiCambioAppelloInCoda', () => {
    const riga = (extra: Partial<LocalPrimariaAppello> = {}): LocalPrimariaAppello => ({
        id: `${ALUNNO}|${DATA}`,
        section_id: 'cccc3333-0000-4000-8000-000000000003',
        alunno_id: ALUNNO,
        data: DATA,
        stato: 'ritardo',
        sync_status: 'pending',
        tentativi: 1,
        aggiornato_il: '2026-09-24T07:00:00.000Z',
        ...extra,
    });

    it('ritira → rimetti: la coda torna ESATTAMENTE com\'era', async () => {
        const originale = riga({ sync_status: 'error', tentativi: 2 });
        h.righe.set(originale.id, originale);
        const ritiro = await ritiraCambioAppelloInCoda(ALUNNO, DATA);
        expect(ritiro.esito).toBe('ritirato');
        expect(h.righe.has(originale.id)).toBe(false);
        if (ritiro.esito !== 'ritirato') throw new Error('atteso ritirato');
        await expect(rimettiCambioAppelloInCoda(ritiro.riga)).resolves.toBe(true);
        expect(h.righe.get(originale.id)).toEqual(originale);
    });

    it('non sovrascrive un cambio più recente già in coda per lo stesso alunno e giorno', async () => {
        const nuovo = riga({ stato: 'assente', tentativi: 0 });
        h.righe.set(nuovo.id, nuovo);
        await expect(rimettiCambioAppelloInCoda(riga())).resolves.toBe(true);
        expect(h.righe.get(nuovo.id)).toEqual(nuovo);
    });

    it('scrittura rifiutata: non lancia, restituisce false e logga `error` col solo nome dell\'errore', async () => {
        h.scritturaRotta = true;
        await expect(rimettiCambioAppelloInCoda(riga())).resolves.toBe(false);
        expect(h.logClient).toHaveBeenCalledTimes(1);
        const arg = h.logClient.mock.calls[0][0] as { livello: string; messaggio: string };
        expect(arg.livello).toBe('error');
        expect(arg.messaggio).toBe('appello-primaria-cambio-non-rimesso-in-coda: RangeError');
        expect(JSON.stringify(arg)).not.toContain(ALUNNO);
    });
});
