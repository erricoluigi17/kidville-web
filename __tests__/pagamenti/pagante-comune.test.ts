import { describe, it, expect } from 'vitest'
import { scegliPaganteComune } from '@/lib/pagamenti/pagante-comune'

// Logica PURA del ponte «alunni riconosciuti per CF → genitore pagante comune».
// Un bonifico di famiglia salda più figli: il pagante è il genitore legato a
// TUTTI gli alunni riconosciuti. Fra più candidati comuni vince l'intestatario
// di default; a parità, scelta deterministica (ordinamento). Se nessun genitore
// è comune a tutti → null (degradazione: la UI aprirà «scegli pagante»).

const link = (parent_id: string, student_id: string) => ({ parent_id, student_id })

describe('scegliPaganteComune', () => {
  it('ritorna il genitore comune a tutti gli alunni richiesti', () => {
    const links = [link('mamma', 'a1'), link('mamma', 'a2')]
    expect(scegliPaganteComune(links, ['a1', 'a2'])).toBe('mamma')
  })

  it('fra due genitori comuni a tutti, vince l\'intestatario di default', () => {
    const links = [link('mamma', 'a1'), link('mamma', 'a2'), link('papa', 'a1'), link('papa', 'a2')]
    expect(scegliPaganteComune(links, ['a1', 'a2'], new Set(['papa']))).toBe('papa')
  })

  it('due genitori comuni, nessun default → scelta deterministica (ordinata)', () => {
    const links = [link('zeta', 'a1'), link('zeta', 'a2'), link('alfa', 'a1'), link('alfa', 'a2')]
    expect(scegliPaganteComune(links, ['a1', 'a2'])).toBe('alfa')
  })

  it('nessun genitore comune a TUTTI → null (degradazione)', () => {
    // mamma solo di a1, papà solo di a2: nessuno copre entrambi
    const links = [link('mamma', 'a1'), link('papa', 'a2')]
    expect(scegliPaganteComune(links, ['a1', 'a2'])).toBeNull()
  })

  it('un solo alunno → il suo (unico) genitore', () => {
    expect(scegliPaganteComune([link('mamma', 'a1')], ['a1'])).toBe('mamma')
  })

  it('lista alunni vuota → null', () => {
    expect(scegliPaganteComune([link('mamma', 'a1')], [])).toBeNull()
  })

  it('ignora i legami di alunni NON richiesti', () => {
    // papà è legato ad a1,a2 (richiesti) e ad a3 (non richiesto): resta comune ai richiesti
    const links = [link('papa', 'a1'), link('papa', 'a2'), link('papa', 'a3'), link('mamma', 'a1')]
    expect(scegliPaganteComune(links, ['a1', 'a2'])).toBe('papa')
  })

  it('tollera legami duplicati e con id mancanti', () => {
    const links = [link('mamma', 'a1'), link('mamma', 'a1'), link('mamma', 'a2'), { parent_id: null, student_id: 'a2' }]
    expect(scegliPaganteComune(links, ['a1', 'a2'])).toBe('mamma')
  })
})
