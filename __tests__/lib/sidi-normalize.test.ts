import { describe, it, expect } from 'vitest'
import { normalizeSidiRow } from '@/lib/sidi/zip-parser'

describe('normalizeSidiRow', () => {
  it('mappa le colonne UPPER_SNAKE in un record normalizzato', () => {
    const r = normalizeSidiRow({
      NUMERO_DOMANDA: '123',
      ALUNNO_CF: 'RSSMRC15C01H501Z',
      ALUNNO_NOME: 'Marco',
      ALUNNO_COGNOME: 'Rossi',
      GENITORE1_CF: 'VRDLGU80A01H501X',
      GENITORE1_NOME: 'Luigi',
      GENITORE1_RELAZIONE: 'padre',
      GENITORE2_CF: 'BNCANN85A41H501Y',
      GENITORE2_NOME: 'Anna',
    })
    expect(r).not.toBeNull()
    expect(r!.numero_domanda).toBe('123')
    expect(r!.alunno.cognome).toBe('Rossi')
    expect(r!.genitori).toHaveLength(2)
    expect(r!.genitori[1].nome).toBe('Anna')
  })

  it('è tollerante alla cassa delle chiavi', () => {
    const r = normalizeSidiRow({ numero_domanda: '5', alunno_nome: 'Eva' })
    expect(r!.numero_domanda).toBe('5')
    expect(r!.alunno.nome).toBe('Eva')
  })

  it('torna null senza numero domanda', () => {
    expect(normalizeSidiRow({ ALUNNO_NOME: 'Senza' })).toBeNull()
    expect(normalizeSidiRow({ NUMERO_DOMANDA: '   ' })).toBeNull()
  })
})
