import { describe, it, expect } from 'vitest'
import { bucketDiPagamento, bucketScadenze } from '@/lib/pagamenti/aging'

const OGGI = '2026-07-10'
const p = (over: Partial<{ importo: number; importo_pagato: number; scadenza: string; stato: string; tipo: string }>) => ({
  importo: 100, importo_pagato: 0, scadenza: '2026-07-15', stato: 'da_pagare', tipo: 'singolo', ...over,
})

describe('bucketDiPagamento', () => {
  it('scaduto da più di 30 giorni → scaduti_oltre_30', () => {
    expect(bucketDiPagamento(p({ scadenza: '2026-05-31', stato: 'scaduto' }), OGGI)).toBe('scaduti_oltre_30')
  })
  it('scaduto da 10 giorni → scaduti_entro_30 (conta la data, non lo stato)', () => {
    expect(bucketDiPagamento(p({ scadenza: '2026-06-30', stato: 'da_pagare' }), OGGI)).toBe('scaduti_entro_30')
  })
  it('scade oggi o entro 7 giorni → settimana', () => {
    expect(bucketDiPagamento(p({ scadenza: '2026-07-10' }), OGGI)).toBe('settimana')
    expect(bucketDiPagamento(p({ scadenza: '2026-07-17' }), OGGI)).toBe('settimana')
  })
  it('scade tra 8 e 30 giorni → mese', () => {
    expect(bucketDiPagamento(p({ scadenza: '2026-07-18' }), OGGI)).toBe('mese')
    expect(bucketDiPagamento(p({ scadenza: '2026-08-09' }), OGGI)).toBe('mese')
  })
  it('oltre 30 giorni nel futuro → nessun bucket', () => {
    expect(bucketDiPagamento(p({ scadenza: '2026-09-10' }), OGGI)).toBeNull()
  })
  it('esclude saldati, contenitori padre e residuo zero', () => {
    expect(bucketDiPagamento(p({ stato: 'pagato', importo_pagato: 100 }), OGGI)).toBeNull()
    expect(bucketDiPagamento(p({ tipo: 'padre' }), OGGI)).toBeNull()
    expect(bucketDiPagamento(p({ importo_pagato: 100 }), OGGI)).toBeNull()
  })
})

describe('bucketScadenze', () => {
  it('aggrega conteggio e residuo per bucket', () => {
    const rows = [
      p({ scadenza: '2026-05-01' }),                       // oltre 30
      p({ scadenza: '2026-07-01', importo_pagato: 40 }),   // entro 30, residuo 60
      p({ scadenza: '2026-07-12' }),                       // settimana
      p({ scadenza: '2026-08-01' }),                       // mese
      p({ stato: 'pagato', importo_pagato: 100 }),         // escluso
    ]
    const b = bucketScadenze(rows, OGGI)
    expect(b.scaduti_oltre_30.count).toBe(1)
    expect(b.scaduti_entro_30.count).toBe(1)
    expect(b.scaduti_entro_30.totale).toBe(60)
    expect(b.settimana.count).toBe(1)
    expect(b.mese.count).toBe(1)
    expect(b.mese.items).toHaveLength(1)
  })
})
