import { describe, it, expect } from 'vitest'
import { hashMovimento, parseCsv, suggerisciMatch } from '@/lib/pagamenti/riconciliazione'

describe('parseCsv', () => {
  it('separatore ; con intestazioni-sinonimo bancarie e importi italiani', () => {
    const csv = [
      'Data;Entrate;Descrizione;Ordinante',
      '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE ROSSI MARIO;ROSSI GIUSEPPE',
      '06/09/2026;-30,00;PAGAMENTO POS;—',            // uscita → scartata
      '07/09/2026;1.234,56;SALDO GITA;BIANCHI',
    ].join('\n')
    const r = parseCsv(csv)
    expect(r.movimenti).toHaveLength(2)
    expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 150 })
    expect(r.movimenti[1].importo).toBe(1234.56)
    expect(r.scartate).toBe(1)
  })

  it('separatore , con virgolette e date ISO', () => {
    const csv = 'date,amount,description\n2026-09-05,"150.00","Retta, settembre — Rossi"\n'
    const r = parseCsv(csv)
    expect(r.movimenti).toHaveLength(1)
    expect(r.movimenti[0].causale).toContain('Retta, settembre')
  })

  it('mapping esplicito prevale sui sinonimi', () => {
    const csv = 'colA;colB\n05/09/2026;99,50\n'
    const r = parseCsv(csv, { data: 'colA', importo: 'colB' })
    expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 99.5 })
  })

  it('senza colonne riconoscibili → nessun movimento', () => {
    const r = parseCsv('foo;bar\n1;2\n')
    expect(r.movimenti).toHaveLength(0)
  })
})

describe('hashMovimento', () => {
  const m = { data_operazione: '2026-09-05', importo: 150, causale: 'Bonifico Rossi', controparte: '' }
  it('stabile e sensibile ai campi chiave', () => {
    expect(hashMovimento(m)).toBe(hashMovimento({ ...m }))
    expect(hashMovimento(m)).not.toBe(hashMovimento({ ...m, importo: 151 }))
    expect(hashMovimento(m)).not.toBe(hashMovimento({ ...m, data_operazione: '2026-09-06' }))
  })
})

describe('suggerisciMatch', () => {
  const aperti = [
    { id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Mario Rossi' },
    { id: 'p2', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Lia Bianchi' },
    { id: 'p3', descrizione: 'Gita zoo', importo: 25, importo_pagato: 0, alunno_nome: 'Mario Rossi' },
  ]

  it('importo esatto + nome in causale → suggerito con distacco', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO RETTA SETTEMBRE ROSSI MARIO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.suggerimenti[0].pagamento_id).toBe('p1')
    expect(r.suggerimenti[0].score).toBeGreaterThanOrEqual(75)
  })

  it('due candidati equivalenti (solo importo) → da_abbinare con entrambi i suggerimenti', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('da_abbinare')
    expect(r.suggerimenti.length).toBeGreaterThanOrEqual(2)
  })

  it('nessun segnale → da_abbinare senza suggerimenti', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 999, causale: 'GIROCONTO INTERNO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('da_abbinare')
    expect(r.suggerimenti).toHaveLength(0)
  })
})
