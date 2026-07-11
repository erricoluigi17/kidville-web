import { describe, it, expect } from 'vitest'
import { buildOrdineFornitorePdf } from '@/lib/merch/pdf'

describe('buildOrdineFornitorePdf', () => {
  it('produce un PDF (Buffer con header %PDF)', () => {
    const buf = buildOrdineFornitorePdf({
      numero: 'PO-2026-001',
      committente: { denominazione: 'Kidville', piva: '01234567890' },
      fornitore: { nome: 'ForniTop', email: 'a@b.it' },
      righe: [
        { articolo: 'Polo', taglia: 'M', quantita: 5 },
        { articolo: 'Cappellino', taglia: '', quantita: 3 },
      ],
      note: 'Consegna entro fine mese',
    })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })
})
