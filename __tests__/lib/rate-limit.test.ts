import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, resetRateLimit, clientIp } from '@/lib/security/rate-limit';

describe('rate-limit (in-memory sliding window)', () => {
  beforeEach(() => resetRateLimit());

  it('allows up to the limit then blocks with ok=false', () => {
    const opts = { limit: 5, windowMs: 1000 };
    for (let i = 0; i < 5; i++) expect(rateLimit('k', opts).ok).toBe(true);
    const blocked = rateLimit('k', opts);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps separate counters per key', () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(rateLimit('a', opts).ok).toBe(true);
    expect(rateLimit('b', opts).ok).toBe(true);
    expect(rateLimit('a', opts).ok).toBe(false);
  });

  it('resets after the window elapses', () => {
    const opts = { limit: 5, windowMs: 1000 };
    for (let i = 0; i < 5; i++) rateLimit('k', opts, 1000);
    expect(rateLimit('k', opts, 1000).ok).toBe(false);
    expect(rateLimit('k', opts, 2001).ok).toBe(true); // window passed
  });

  it('clientIp takes the first x-forwarded-for hop', () => {
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('clientIp falls back to x-real-ip then unknown', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});
