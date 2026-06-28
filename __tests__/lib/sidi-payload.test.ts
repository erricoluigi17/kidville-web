import { describe, it, expect } from 'vitest'
import { buildFaseAReconcile, buildFrequentanti, buildGenitoriAlunni } from '@/lib/sidi/payload'

describe('buildFaseAReconcile', () => {
  it('unisce sezioni e tempo scuola attivo', () => {
    const out = buildFaseAReconcile({
      sezioni: [{ id: 's1', name: '5A', school_type: 'primaria' }],
      tempoScuola: [{ section_id: 's1', modello: 40, giorni_settimana: 5, attivo: true }],
    })
    expect(out.sezioni[0].tempoScuola).toEqual({ modello: 40, giorni: 5 })
  })

  it('tempo scuola non attivo è ignorato', () => {
    const out = buildFaseAReconcile({
      sezioni: [{ id: 's1', name: '5A', school_type: 'primaria' }],
      tempoScuola: [{ section_id: 's1', modello: 27, giorni_settimana: 5, attivo: false }],
    })
    expect(out.sezioni[0].tempoScuola).toBeNull()
  })
})

describe('buildFrequentanti', () => {
  it('include solo gli iscritti e raggruppa per sezione', () => {
    const out = buildFrequentanti({
      sezioni: [{ id: 's1', name: '5A' }],
      alunni: [
        { id: 'a1', section_id: 's1', codice_fiscale: 'CF1', nome: 'M', cognome: 'R', stato: 'iscritto' },
        { id: 'a2', section_id: 's1', codice_fiscale: 'CF2', nome: 'A', cognome: 'B', stato: 'ritirato' },
      ],
    })
    expect(out.perClasse).toHaveLength(1)
    expect(out.perClasse[0].alunni).toHaveLength(1)
    expect(out.perClasse[0].alunni[0].id).toBe('a1')
  })
})

describe('buildGenitoriAlunni', () => {
  it('include solo i legami validati dalla segreteria', () => {
    const out = buildGenitoriAlunni({
      legami: [
        { student_cf: 'CFA', parent_cf: 'CFP1', relation_type: 'madre', validato: true },
        { student_cf: 'CFA', parent_cf: 'CFP2', relation_type: 'padre', validato: false },
      ],
    })
    expect(out.associazioni).toHaveLength(1)
    expect(out.associazioni[0].genitoreCF).toBe('CFP1')
  })
})
