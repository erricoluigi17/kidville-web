import { describe, it, expect } from 'vitest'
import { buildReceiptPdf, computeContentHash } from '@/lib/fea/receipt-pdf'
import type { ReceiptPayload } from '@/lib/fea/types'

describe('computeContentHash', () => {
  it('deterministico e indipendente dall\'ordine delle chiavi', () => {
    const a = computeContentHash({ b: 2, a: 1, nested: { y: 2, x: 1 } }, { m: 'OTP_EMAIL' })
    const b = computeContentHash({ a: 1, b: 2, nested: { x: 1, y: 2 } }, { m: 'OTP_EMAIL' })
    expect(a).toBe(b)
    expect(a).toMatch(/^SHA256-[A-F0-9]+$/)
  })

  it('cambia se il documento muta (prova di inattaccabilità)', () => {
    const a = computeContentHash({ voto: 'ottimo' }, {})
    const b = computeContentHash({ voto: 'distinto' }, {})
    expect(a).not.toBe(b)
  })

  it('cambia se i metadati di firma mutano', () => {
    const a = computeContentHash({ x: 1 }, { signed_at: '2026-06-25T10:00:00Z' })
    const b = computeContentHash({ x: 1 }, { signed_at: '2026-06-26T10:00:00Z' })
    expect(a).not.toBe(b)
  })
})

describe('buildReceiptPdf', () => {
  const payload: ReceiptPayload = {
    title: 'Ricevuta di firma — Pagella',
    entitaTipo: 'pagella',
    entitaId: 'e-1',
    schoolName: 'Kidville',
    signer: { name: 'Maria Rossi', email: 'maria@example.it' },
    signature: {
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email: 'maria@example.it',
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0',
      signed_at: '2026-06-25T10:00:00.000Z',
      timestamp: '2026-06-25T10:00:00.000Z',
      hash: 'SHA256-ABC',
      compliance: 'CAD Art. 20 / DPR 445/2000',
    },
    documentPayload: { scrutinio: 's-1', alunno: 'a-1' },
  }

  it('produce un Buffer PDF non vuoto che inizia con %PDF', () => {
    const buf = buildReceiptPdf(payload)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(200)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })
})
