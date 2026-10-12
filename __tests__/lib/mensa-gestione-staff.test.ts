import { describe, it, expect } from 'vitest'
import { RUOLI_GESTIONE_MENSA, gestisceMensa, nonPrenotatiPerClasse } from '@/lib/mensa/gestione-staff'

describe('chi gestisce le prenotazioni mensa', () => {
  it('sono admin, coordinator e segreteria — gli stessi che la route esenta dal cutoff', () => {
    expect([...RUOLI_GESTIONE_MENSA]).toEqual(['admin', 'coordinator', 'segreteria'])
  })
  it('cuoca, docente, genitore e ruolo sconosciuto no', () => {
    for (const r of ['cuoca', 'educator', 'genitore', '', null, undefined]) expect(gestisceMensa(r)).toBe(false)
    for (const r of ['admin', 'coordinator', 'segreteria']) expect(gestisceMensa(r)).toBe(true)
  })
})

describe('nonPrenotatiPerClasse', () => {
  const iscritti = [
    { id: 'a1', nome: 'Bimbo', cognome: 'Uno', classe_sezione: 'Girasoli' },
    { id: 'a2', nome: 'Bimba', cognome: 'Due', classe_sezione: 'Girasoli' },
    { id: 'a3', nome: 'Anna', cognome: 'Tre', classe_sezione: 'Girasoli' },
    { id: 'a4', nome: 'Bimbo', cognome: 'Quattro', classe_sezione: 'Tulipani' },
    { id: 'a5', nome: 'Senza', cognome: 'Classe', classe_sezione: null },
  ]
  it('esclude i prenotati, raggruppa per classe e ordina per nome', () => {
    const m = nonPrenotatiPerClasse(iscritti, new Set(['a1']))
    expect(m.get('Girasoli')).toEqual([{ id: 'a3', nome: 'Anna Tre' }, { id: 'a2', nome: 'Bimba Due' }])
    expect(m.get('Tulipani')).toEqual([{ id: 'a4', nome: 'Bimbo Quattro' }])
  })
  it('chi non ha classe va in «—», come nel report', () => {
    expect(nonPrenotatiPerClasse(iscritti, new Set()).get('—')).toEqual([{ id: 'a5', nome: 'Senza Classe' }])
  })
  it('una classe tutta prenotata non compare', () => {
    expect(nonPrenotatiPerClasse(iscritti, new Set(['a4'])).has('Tulipani')).toBe(false)
  })
})
