import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rateLimit, resetRateLimit, clientIp } from '@/lib/security/rate-limit';

/**
 * IL RAMO DI DEGRADO — cioè il contatore LOCALE, per istanza.
 *
 * Questi test esistevano da prima che il contatore diventasse condiviso, e la tentazione
 * era cancellarli. Sarebbe stato sbagliato: da quando `rateLimit` degrada al conteggio
 * locale quando Postgres non risponde, quel ramo non è più «il vecchio codice» — è la rete
 * di sicurezza che regge quando il database è giù, e va provata come tutto il resto.
 *
 * Qui il client Supabase non c'è (nessun mock di `createAdminClient`), quindi
 * `consumaCondiviso` non riesce a decidere e si ricade sul locale a ogni chiamata: è
 * esattamente lo scenario che si vuole misurare.
 *
 * Il tetto CONDIVISO — quello che deve valere fra due istanze diverse, e che una `Map` non
 * potrebbe mai soddisfare — vive in `__tests__/lib/rate-limit-condiviso.test.ts`, che carica
 * il modulo due volte e verifica che il conto sia unico. Sono due file perché sono due
 * proprietà diverse: qui «il locale conta bene», là «il locale non basta».
 */
describe('rate-limit · il ramo di degrado (contatore per istanza)', () => {
  beforeEach(() => resetRateLimit());

  it('consente fino al limite, poi blocca', async () => {
    const opts = { limit: 5, windowMs: 1000 };
    for (let i = 0; i < 5; i++) expect((await rateLimit('k', opts)).ok).toBe(true);
    const bloccato = await rateLimit('k', opts);
    expect(bloccato.ok).toBe(false);
    expect(bloccato.remaining).toBe(0);
    expect(bloccato.retryAfterMs).toBeGreaterThan(0);
  });

  it('tiene contatori separati per chiave', async () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect((await rateLimit('a', opts)).ok).toBe(true);
    expect((await rateLimit('b', opts)).ok).toBe(true);
    expect((await rateLimit('a', opts)).ok).toBe(false);
  });

  it('riparte quando la finestra è passata', async () => {
    const opts = { limit: 5, windowMs: 1000 };
    for (let i = 0; i < 5; i++) await rateLimit('k', opts, 1000);
    expect((await rateLimit('k', opts, 1000)).ok).toBe(false);
    expect((await rateLimit('k', opts, 2001)).ok).toBe(true); // finestra scaduta
  });

  /**
   * LA PROVA CHE IL TETTO NON SI SCAVALCA CON LA CONCORRENZA.
   *
   * `Promise.all` di `limit + N` chiamate sulla stessa chiave: devono passarne ESATTAMENTE
   * `limit`, non una di più. È la proprietà che un'implementazione a due passi (leggi il
   * contatore, poi scrivilo) sbaglia in silenzio — e che si nota solo sotto carico, cioè
   * quando serve.
   */
  it('sotto concorrenza sulla stessa chiave passano esattamente `limit` richieste', async () => {
    const opts = { limit: 3, windowMs: 10_000 };
    const esiti = await Promise.all(
      Array.from({ length: 12 }, () => rateLimit('concorrenza', opts, 5_000)),
    );
    expect(esiti.filter((e) => e.ok)).toHaveLength(3);
    expect(esiti.filter((e) => !e.ok)).toHaveLength(9);
  });

  /**
   * LA PERDITA DI MEMORIA CHE C'ERA PRIMA.
   *
   * La `Map` non cancellava MAI una chiave: su una rotta pubblica ogni IP che bussava una
   * volta sola lasciava una voce per tutta la vita dell'istanza. Il test guarda la
   * DIMENSIONE dello store dopo che le finestre sono passate — se qualcuno togliesse la
   * potatura, il numero resterebbe a 700 e questo cade.
   */
  it('lo store locale si pota delle chiavi scadute invece di crescere per sempre', async () => {
    const { dimensioneStoreLocale } = await import('@/lib/security/rate-limit');
    const opts = { limit: 1, windowMs: 1_000 };
    for (let i = 0; i < 700; i++) await rateLimit(`ip-${i}`, opts, 1_000);
    expect(dimensioneStoreLocale()).toBe(700);

    // Una richiesta molto dopo: le 700 finestre sono finite da un pezzo.
    await rateLimit('ip-nuovo', opts, 1_000 + 60_000);
    expect(dimensioneStoreLocale()).toBeLessThan(700);
  });

  it('clientIp prende il primo hop di x-forwarded-for', () => {
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('clientIp ripiega su x-real-ip e poi su unknown', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});

/**
 * IL DEGRADO NON DEVE MAI TACERE (AGENTS.md, regola 6: un catch che non logga è un bug).
 *
 * Un tetto che non ha potuto interrogare il contatore condiviso sta lavorando con una
 * garanzia più debole di quella che promette. Se lo facesse in silenzio, nessuno saprebbe
 * mai che per due ore il tetto è stato quello di ieri.
 */
describe('rate-limit · il degrado lascia una riga', () => {
  beforeEach(() => {
    resetRateLimit();
    vi.resetModules();
  });

  it('quando il client Supabase non si costruisce, logga a livello error e NON tace', async () => {
    vi.resetModules();
    const logEvento = vi.fn();
    vi.doMock('@/lib/logging/logger', () => ({
      logEvento,
      logErrore: vi.fn(),
      logOk: vi.fn(),
    }));
    vi.doMock('@/lib/supabase/server-client', () => ({
      createAdminClient: () => Promise.reject(new Error('nessun client')),
    }));

    const mod = await import('@/lib/security/rate-limit');
    mod.resetRateLimit();
    const esito = await mod.rateLimit('iscrizione:1.2.3.4', { limit: 5, windowMs: 1000 });

    // La richiesta passa (si degrada, non si blocca)…
    expect(esito.ok).toBe(true);
    // …ma il fatto è scritto, a livello `error`, e senza l'IP dentro.
    expect(logEvento).toHaveBeenCalled();
    const [canale, livello, campi] = logEvento.mock.calls[0];
    expect(canale).toBe('db');
    expect(livello).toBe('error');
    expect(campi.esito).toBe('conteggio_locale');
    expect(JSON.stringify(campi)).not.toContain('1.2.3.4');

    vi.doUnmock('@/lib/logging/logger');
    vi.doUnmock('@/lib/supabase/server-client');
  });
});
