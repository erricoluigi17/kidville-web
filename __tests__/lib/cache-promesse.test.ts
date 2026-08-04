import { describe, it, expect, vi } from 'vitest';
import { creaCachePromesse } from '@/lib/rete/cache-promesse';

/**
 * La deduplica delle GET identiche vive in un posto solo: qui si misura che
 * faccia le quattro cose che le si chiedono — condividere la richiesta in volo,
 * NON mescolare chiavi diverse, non congelare un esito non determinabile, e
 * lasciarsi svuotare quando l'identità cambia.
 */

describe('creaCachePromesse', () => {
  it('due letture contemporanee della stessa chiave = una sola richiesta', async () => {
    const carica = vi.fn(async () => 'valore');
    const cache = creaCachePromesse(carica);

    const [a, b] = await Promise.all([cache.leggi('k'), cache.leggi('k')]);

    expect(a).toBe('valore');
    expect(b).toBe('valore');
    expect(carica).toHaveBeenCalledTimes(1);
  });

  it('una lettura dopo che la prima si è risolta riusa il valore', async () => {
    const carica = vi.fn(async () => 'valore');
    const cache = creaCachePromesse(carica);

    await cache.leggi('k');
    await cache.leggi('k');

    expect(carica).toHaveBeenCalledTimes(1);
  });

  it('chiavi diverse NON si mescolano: due richieste, due valori', async () => {
    const carica = vi.fn(async (chiave: string) => `valore-${chiave}`);
    const cache = creaCachePromesse(carica);

    expect(await cache.leggi('genitore-1')).toBe('valore-genitore-1');
    expect(await cache.leggi('genitore-2')).toBe('valore-genitore-2');
    expect(carica).toHaveBeenCalledTimes(2);
  });

  it('esito non determinabile (null) non si conserva: la lettura dopo richiama', async () => {
    const carica = vi.fn<(chiave: string) => Promise<string | null>>();
    carica.mockResolvedValueOnce(null).mockResolvedValueOnce('finalmente');
    const cache = creaCachePromesse(carica);

    expect(await cache.leggi('k')).toBeNull();
    expect(await cache.leggi('k')).toBe('finalmente');
    expect(carica).toHaveBeenCalledTimes(2);
  });

  it('un rigetto arriva al chiamante e non resta in cache', async () => {
    const carica = vi.fn<(chiave: string) => Promise<string>>();
    carica.mockRejectedValueOnce(new Error('rete giù')).mockResolvedValueOnce('ok');
    const cache = creaCachePromesse(carica);

    await expect(cache.leggi('k')).rejects.toThrow('rete giù');
    expect(await cache.leggi('k')).toBe('ok');
    expect(carica).toHaveBeenCalledTimes(2);
  });

  it('invalida(chiave) tocca solo quella; invalida() svuota tutto', async () => {
    const carica = vi.fn(async (chiave: string) => `valore-${chiave}`);
    const cache = creaCachePromesse(carica);

    await cache.leggi('a');
    await cache.leggi('b');
    expect(carica).toHaveBeenCalledTimes(2);

    cache.invalida('a');
    await cache.leggi('a'); // richiamata
    await cache.leggi('b'); // ancora in cache
    expect(carica).toHaveBeenCalledTimes(3);

    cache.invalida();
    await cache.leggi('a');
    await cache.leggi('b');
    expect(carica).toHaveBeenCalledTimes(5);
  });
});
