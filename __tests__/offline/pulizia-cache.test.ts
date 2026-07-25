import { describe, it, expect, beforeEach, vi } from 'vitest';

// La cache di lettura offline non si svuotava e non scadeva mai: sopravviveva al
// logout e all'oblio GDPR, e le chiavi per-giorno (`diario:<alunno>:<gg>`,
// `menu:<alunno>:<from>:<to>`) crescevano all'infinito. L'indice `aggiornato_il`
// esisteva dalla version(11) di db.ts ed era dichiarato «per pulizia per età»,
// ma nessuno lo interrogava.

// `where(...).below(...).delete()` — la catena Dexie va riprodotta per intero,
// altrimenti l'implementazione lancia e il catch nasconde il difetto al test.
const deleteScadute = vi.hoisted(() => vi.fn(async () => 0));
const below = vi.hoisted(() => vi.fn(() => ({ delete: deleteScadute })));
const where = vi.hoisted(() => vi.fn(() => ({ below })));
const count = vi.hoisted(() => vi.fn(async () => 0));
const primaryKeys = vi.hoisted(() => vi.fn(async () => [] as string[]));
const limit = vi.hoisted(() => vi.fn(() => ({ primaryKeys })));
const orderBy = vi.hoisted(() => vi.fn(() => ({ limit, count })));
const bulkDelete = vi.hoisted(() => vi.fn(async () => undefined));
const clear = vi.hoisted(() => vi.fn(async () => undefined));
const clearDiario = vi.hoisted(() => vi.fn(async () => undefined));
const clearPresenze = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/offline/db', () => ({
    db: {
        cache_read: { where, count, orderBy, bulkDelete, clear },
        // Presenti apposta: il test verifica che NON vengano toccati.
        diario: { clear: clearDiario },
        presenze: { clear: clearPresenze },
    },
}));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({ logClient }));

import {
    MAX_VOCI_CACHE_READ,
    TTL_CACHE_READ_MS,
    pulisciCacheScaduta,
    svuotaCacheLocale,
} from '@/lib/offline/pulizia-cache';

beforeEach(() => {
    vi.clearAllMocks();
    deleteScadute.mockResolvedValue(0);
    count.mockResolvedValue(0);
    primaryKeys.mockResolvedValue([]);
});

describe('pulisciCacheScaduta', () => {
    it('interroga l’INDICE `aggiornato_il`, non filtra in memoria', async () => {
        // Con qualche migliaio di voci la differenza fra i due è un blocco
        // visibile della UI, e l'indice esiste apposta.
        await pulisciCacheScaduta(new Date('2026-07-25T12:00:00.000Z'));
        expect(where).toHaveBeenCalledWith('aggiornato_il');
        expect(below).toHaveBeenCalledTimes(1);
    });

    it('la soglia è «adesso meno il TTL», in ISO UTC', async () => {
        // I valori sono ISO a larghezza fissa: l'ordine alfabetico coincide con
        // quello cronologico, ed è ciò che rende utilizzabile il range.
        const ora = new Date('2026-07-25T12:00:00.000Z');
        await pulisciCacheScaduta(ora);
        const attesa = new Date(ora.getTime() - TTL_CACHE_READ_MS).toISOString();
        expect(below).toHaveBeenCalledWith(attesa);
    });

    it('il TTL è di 7 giorni: la settimana scolastica', async () => {
        expect(TTL_CACHE_READ_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('cancella davvero le voci scadute e le conta', async () => {
        deleteScadute.mockResolvedValue(4);
        expect(await pulisciCacheScaduta()).toBe(4);
    });

    it('oltre il tetto di voci cancella le PIÙ VECCHIE', async () => {
        count.mockResolvedValue(MAX_VOCI_CACHE_READ + 50);
        primaryKeys.mockResolvedValue(Array.from({ length: 50 }, (_, i) => `k${i}`));
        const rimosse = await pulisciCacheScaduta();
        expect(orderBy).toHaveBeenCalledWith('aggiornato_il');
        expect(limit).toHaveBeenCalledWith(50);
        expect(bulkDelete).toHaveBeenCalledTimes(1);
        expect(rimosse).toBe(50);
    });

    it('sotto il tetto non cancella nulla in più', async () => {
        count.mockResolvedValue(10);
        await pulisciCacheScaduta();
        expect(bulkDelete).not.toHaveBeenCalled();
    });

    it('un guasto di IndexedDB non lancia, ma NON passa in silenzio', async () => {
        // Se la pulizia non gira, dei dati di minori restano sul dispositivo
        // oltre il periodo dichiarato nell'informativa: va detto.
        deleteScadute.mockRejectedValueOnce(new Error('indexeddb non disponibile'));
        await expect(pulisciCacheScaduta()).resolves.toBe(0);
        expect(logClient).toHaveBeenCalledTimes(1);
        expect(logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn', evento: 'offline' });
    });
});

describe('svuotaCacheLocale', () => {
    it('svuota la cache di lettura', async () => {
        await svuotaCacheLocale();
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('NON tocca gli store con scritture non sincronizzate', async () => {
        // `presenze`, `diario`, `armadietto`… contengono `sync_status: pending`:
        // svuotarli al logout butterebbe via il lavoro offline di una docente.
        await svuotaCacheLocale();
        expect(clearDiario).not.toHaveBeenCalled();
        expect(clearPresenze).not.toHaveBeenCalled();
    });

    it('un guasto non lancia e viene segnalato', async () => {
        clear.mockRejectedValueOnce(new Error('ko'));
        await expect(svuotaCacheLocale()).resolves.toBeUndefined();
        expect(logClient).toHaveBeenCalledTimes(1);
    });
});
