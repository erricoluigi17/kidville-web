import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, sendEmailDetailed } from '@/lib/email/send';

// Il motivo del rifiuto del provider NON deve andare perso: è la differenza tra
// un debugging immediato ("dominio non verificato: consegna solo al titolare")
// e settimane di "la mail non arriva" (caso reale S6bis).

const realFetch = global.fetch;
const realKey = process.env.RESEND_API_KEY;

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
});

afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

const params = { to: 'x@y.it', subject: 'S', text: 'T' };

describe('sendEmailDetailed', () => {
  it('senza RESEND_API_KEY → fallback log con motivo esplicito', async () => {
    delete process.env.RESEND_API_KEY;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/provider email non configurato/);
  });

  it('200 → ok senza errore, e con l\'id del messaggio Resend', async () => {
    global.fetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 })) as typeof fetch;
    const r = await sendEmailDetailed(params);
    // Dal 2026-08-16 l'esito porta anche `messageId`: è l'unica prova d'invio che
    // sopravvive al giorno dopo, e la scrive chi manda gli inviti alle famiglie.
    expect(r).toEqual({ ok: true, error: null, messageId: '1' });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('200 con ricevuta illeggibile → resta OK, messageId null (l\'email È partita)', async () => {
    // Degradare a «fallito» un invio riuscito perché la ricevuta è illeggibile
    // farebbe rispedire l'email: il rimedio sarebbe peggiore del sintomo.
    global.fetch = vi.fn(async () => new Response('non-json', { status: 200 })) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.messageId).toBeNull();
  });

  it('200 senza campo id → OK con messageId null', async () => {
    global.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(true);
    expect(r.messageId).toBeNull();
  });

  it('403 con message JSON → il motivo del provider è propagato (caso sandbox Resend)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ statusCode: 403, message: 'You can only send testing emails to your own email address' }), { status: 403 })
    ) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
    expect(r.error).toMatch(/your own email address/);
  });

  it('corpo errore non-JSON → propagato grezzo', async () => {
    global.fetch = vi.fn(async () => new Response('boom testuale', { status: 500 })) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
    expect(r.error).toMatch(/boom testuale/);
  });

  it('errore di rete → esito negativo, mai eccezione', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('rete giù');
    }) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rete/);
  });
});

describe('sendEmail (wrapper boolean retro-compatibile)', () => {
  it('true su 200, false su rifiuto', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    expect(await sendEmail(params)).toBe(true);
    global.fetch = vi.fn(async () => new Response('{}', { status: 403 })) as typeof fetch;
    expect(await sendEmail(params)).toBe(false);
  });
});
