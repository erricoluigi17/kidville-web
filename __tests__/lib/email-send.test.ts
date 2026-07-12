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

  it('200 → ok senza errore', async () => {
    global.fetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 })) as typeof fetch;
    const r = await sendEmailDetailed(params);
    expect(r).toEqual({ ok: true, error: null });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
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
