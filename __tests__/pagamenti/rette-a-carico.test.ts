import { describe, it, expect } from 'vitest'
import {
  anomaliaPagante, componiBadge, indicizzaLegami, legamiDaRisposta, nomeConClasse, nomePagante,
  prefissoPaganteIt, sessoDa, testoPaganteIt, valoriPrefisso, SEPARATORE_STATO,
  type LegameRetta, type PaganteRetta,
} from '@/lib/pagamenti/rette-a-carico'

const pagante = (extra: Partial<PaganteRetta> = {}): PaganteRetta => ({
  id: 'p1', nome: 'Mario', cognome: 'Rossi', sesso: 'M', classe_sezione: 'Sez. C',
  iscritto: true, scuola_id: 's1', ...extra,
})
const legame = (extra: Partial<PaganteRetta> = {}, sedeBambino = 's1'): LegameRetta => ({
  alunno_id: 'b1', scuola_id: sedeBambino, pagante: pagante(extra),
})

describe('rette a carico — i testi (D1, D2, D5)', () => {
  it('fratello, sorella, sesso assente', () => {
    expect(prefissoPaganteIt(pagante())).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: 'F', nome: 'Anna' }))).toBe('Paga la sorella Anna Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: null }))).toBe('A carico di Mario Rossi (Sez. C)')
  })
  it('senza classe niente parentesi; spazi ripuliti', () => {
    expect(nomeConClasse(pagante({ classe_sezione: null }))).toBe('Mario Rossi')
    expect(nomeConClasse(pagante({ classe_sezione: '   ' }))).toBe('Mario Rossi')
    expect(nomePagante({ nome: ' Mario ', cognome: ' De  Luca ' })).toBe('Mario De Luca')
  })
  it('lo stato si aggiunge dopo il separatore, e solo se c’è', () => {
    expect(SEPARATORE_STATO).toBe(' · ')
    expect(testoPaganteIt(pagante(), 'Da pagare')).toBe('Paga il fratello Mario Rossi (Sez. C) · Da pagare')
    expect(testoPaganteIt(pagante(), null)).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(componiBadge('X', '')).toBe('X')
  })
  it('valoriPrefisso: il sesso assente diventa «nd» (ICU vuole una stringa)', () => {
    expect(valoriPrefisso(pagante({ sesso: null }))).toEqual({ sesso: 'nd', nome: 'Mario Rossi (Sez. C)' })
    expect(valoriPrefisso(pagante())).toEqual({ sesso: 'M', nome: 'Mario Rossi (Sez. C)' })
  })
})

describe('sessoDa', () => {
  it('accetta M/F anche minuscole e con spazi; il resto è null', () => {
    expect(sessoDa('M')).toBe('M')
    expect(sessoDa(' f ')).toBe('F')
    expect(sessoDa('X')).toBeNull()
    expect(sessoDa('')).toBeNull()
    expect(sessoDa(null)).toBeNull()
    expect(sessoDa(1)).toBeNull()
  })
})

describe('anomaliaPagante (D12)', () => {
  it('nessuna anomalia: iscritto e stessa sede', () => {
    expect(anomaliaPagante(legame())).toBeNull()
  })
  it('non iscritto', () => {
    expect(anomaliaPagante(legame({ iscritto: false }))).toBe('non-iscritto')
  })
  it('altra sede', () => {
    expect(anomaliaPagante(legame({ scuola_id: 's2' }))).toBe('altra-sede')
  })
  it('il non iscritto vince sull’altra sede', () => {
    expect(anomaliaPagante(legame({ iscritto: false, scuola_id: 's2' }))).toBe('non-iscritto')
  })
})

describe('indicizzaLegami e legamiDaRisposta', () => {
  it('indicizza per alunno a carico', () => {
    const m = indicizzaLegami([legame()])
    expect(m.get('b1')?.pagante.id).toBe('p1')
    expect(m.size).toBe(1)
  })
  it('una risposta che non è un array è null (guasto, non «nessun legame»)', () => {
    expect(legamiDaRisposta(undefined)).toBeNull()
    expect(legamiDaRisposta({})).toBeNull()
  })
  it('scarta le voci malformate e tiene le buone', () => {
    const buona = legame()
    expect(legamiDaRisposta([buona, null, { alunno_id: 'x' }, { alunno_id: 'y', pagante: { id: 3 } }])).toEqual([buona])
  })
})
