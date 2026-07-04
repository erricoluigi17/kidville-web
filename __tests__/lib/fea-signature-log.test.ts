import { describe, it, expect } from 'vitest'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'

describe('buildSignatureLog', () => {
  it('OTP_EMAIL: superset canonico con signed_at===timestamp, provider FES, compliance CAD', () => {
    const log = buildSignatureLog({
      method: 'OTP_EMAIL',
      email: 'p@x.it',
      ip: '1.2.3.4',
      userAgent: 'UA/1',
      hash: 'SHA256-AB',
      signedAt: '2026-06-25T10:00:00.000Z',
    })
    expect(log).toEqual({
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email: 'p@x.it',
      ip: '1.2.3.4',
      user_agent: 'UA/1',
      signed_at: '2026-06-25T10:00:00.000Z',
      timestamp: '2026-06-25T10:00:00.000Z',
      hash: 'SHA256-AB',
      compliance: 'CAD Art. 20 / DPR 445/2000',
    })
  })

  it('CONFERMA_APP: nessun hash, provider conferma-in-app, user_agent default N.D.', () => {
    const log = buildSignatureLog({
      method: 'CONFERMA_APP',
      email: 'p@x.it',
      ip: '1.2.3.4',
      signedAt: '2026-06-25T10:00:00.000Z',
    })
    expect(log.method).toBe('CONFERMA_APP')
    expect(log.provider).toContain('Conferma in app')
    expect(log.hash).toBeUndefined()
    expect(log.signed_at).toBe('2026-06-25T10:00:00.000Z')
    expect(log.timestamp).toBe(log.signed_at)
    expect(log.user_agent).toBe('N.D.')
  })

  it('signed_at di default è una ISO string e coincide con timestamp', () => {
    const log = buildSignatureLog({ method: 'OTP_EMAIL', email: 'p@x.it', ip: 'N.D.', hash: 'h' })
    expect(typeof log.signed_at).toBe('string')
    expect(log.signed_at).toBe(log.timestamp)
  })
})

describe('extractRequestMeta', () => {
  it('prende il primo hop di x-forwarded-for e lo user-agent', () => {
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8', 'user-agent': 'Moz/5' },
    })
    expect(extractRequestMeta(req)).toEqual({ ip: '9.9.9.9', userAgent: 'Moz/5' })
  })

  it('default N.D. quando mancano gli header', () => {
    const req = new Request('http://x')
    expect(extractRequestMeta(req)).toEqual({ ip: 'N.D.', userAgent: 'N.D.' })
  })
})
