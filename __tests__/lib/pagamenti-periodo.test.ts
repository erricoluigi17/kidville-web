import { describe, it, expect } from 'vitest'
import { meseAnnoDaPeriodo } from '@/lib/pagamenti/periodo'

describe('meseAnnoDaPeriodo', () => {
  it('deriva mese it-IT (in lettere) e anno da una data «yyyy-mm-dd»', () => {
    expect(meseAnnoDaPeriodo('2026-09-01')).toEqual({ mese: 'settembre', anno: '2026' })
    expect(meseAnnoDaPeriodo('2026-01-15')).toEqual({ mese: 'gennaio', anno: '2026' })
    expect(meseAnnoDaPeriodo('2026-12-31')).toEqual({ mese: 'dicembre', anno: '2026' })
  })

  it('è deterministico (niente sfasamenti di fuso: legge la stringa, non new Date)', () => {
    // 2026-06-01T00:00Z in un fuso negativo darebbe «maggio» con getMonth locale.
    expect(meseAnnoDaPeriodo('2026-06-01')).toEqual({ mese: 'giugno', anno: '2026' })
  })

  it('tollera un mese-anno «yyyy-mm» senza giorno', () => {
    expect(meseAnnoDaPeriodo('2026-03')).toEqual({ mese: 'marzo', anno: '2026' })
  })

  it('null/assente/non valido → mese e anno vuoti (omessi con grazia dal renderer)', () => {
    expect(meseAnnoDaPeriodo(null)).toEqual({ mese: '', anno: '' })
    expect(meseAnnoDaPeriodo(undefined)).toEqual({ mese: '', anno: '' })
    expect(meseAnnoDaPeriodo('')).toEqual({ mese: '', anno: '' })
    expect(meseAnnoDaPeriodo('boh')).toEqual({ mese: '', anno: '' })
    expect(meseAnnoDaPeriodo('2026-13-01')).toEqual({ mese: '', anno: '2026' })
  })
})
