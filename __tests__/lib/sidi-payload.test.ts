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

  // LOCK, non nuova funzionalità: fissa una decisione presa il 2026-08-12, non
  // un comportamento cambiato. Quando l'oblio è passato dalle negazioni a un
  // elenco chiuso di stati (`@/lib/alunni/stato`), questo builder è stato
  // lasciato al confronto STRETTO: chi si trasmette al Ministero è una scelta di
  // prodotto, e un `sospeso` oggi non si trasmette. Senza questa riga, un
  // riordino futuro potrebbe allinearlo «per coerenza» e cambiare in silenzio
  // ciò che si dichiara al SIDI.
  it('un alunno SOSPESO non entra fra i frequentanti trasmessi', () => {
    const out = buildFrequentanti({
      sezioni: [{ id: 's1', name: '5A' }],
      alunni: [{ id: 'a3', section_id: 's1', codice_fiscale: 'CF3', nome: 'L', cognome: 'V', stato: 'sospeso' }],
    })
    expect(out.perClasse).toHaveLength(0)
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
