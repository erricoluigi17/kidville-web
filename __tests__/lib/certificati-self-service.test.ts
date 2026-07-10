import { describe, it, expect } from 'vitest'
import { buildCertificatoBody, buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service'

const anna = { nome: 'Anna', cognome: 'Bianchi', classe_sezione: 'TEST 1A' }

describe('buildCertificatoBody', () => {
  it('frequenza: sezione reale, niente partitivo, niente Girasoli', () => {
    const txt = buildCertificatoBody('frequenza', anna, '2025/2026')
    expect(txt).toContain("l'alunno/a Bianchi Anna")
    expect(txt).toContain('nella sezione TEST 1A')
    expect(txt).not.toContain('Girasoli')
    expect(txt).toContain("per l'anno scolastico 2025/2026")
  })
  it('frequenza senza classe: clausola omessa', () => {
    const txt = buildCertificatoBody('frequenza', { nome: 'Anna', cognome: 'Bianchi' }, '2025/2026')
    expect(txt).not.toContain('nella sezione')
    expect(txt).toContain("di questa scuola per l'anno scolastico 2025/2026")
  })
  it('classe vuota/spazi = assente', () => {
    expect(buildCertificatoBody('frequenza', { ...anna, classe_sezione: '  ' }, '2025/2026'))
      .not.toContain('nella sezione')
  })
  it('iscrizione: anno dinamico', () => {
    const txt = buildCertificatoBody('iscrizione', anna, '2025/2026')
    expect(txt).toContain('regolarmente iscritto/a')
    expect(txt).toContain("per l'anno scolastico 2025/2026.")
  })
})

describe('buildIntestazioneSede (multi-sede)', () => {
  it('sede completa → 3 righe con dati reali', () => {
    const righe = buildIntestazioneSede({
      scuola_nome: 'Kidville Giugliano', scuola_indirizzo: 'Via Roma 1', scuola_cap: '80014',
      scuola_citta: 'Giugliano', scuola_provincia: 'NA', scuola_codice_meccanografico: 'NA1E123456',
    })
    expect(righe).toHaveLength(3)
    expect(righe[0]).toBe('Kidville Giugliano')
    expect(righe[1]).toContain('Via Roma 1')
    expect(righe[1]).toContain('80014 Giugliano')
    expect(righe[1]).toContain('(NA)')
    expect(righe[2]).toBe('Cod. Mecc. NA1E123456')
  })
  it('due sedi diverse → intestazioni diverse (multi-sede)', () => {
    const a = buildIntestazioneSede({ scuola_nome: 'Sede A', scuola_citta: 'Giugliano' })
    const b = buildIntestazioneSede({ scuola_nome: 'Sede B', scuola_citta: 'Napoli' })
    expect(a[0]).toBe('Sede A')
    expect(b[0]).toBe('Sede B')
    expect(a).not.toEqual(b)
  })
  it('dati mancanti → righe omesse, mai inventate', () => {
    expect(buildIntestazioneSede({})).toEqual([])
    expect(buildIntestazioneSede({ scuola_nome: 'Solo Nome' })).toEqual(['Solo Nome'])
  })
})

describe('rigaLuogoData', () => {
  it('con città dal DB', () => {
    expect(rigaLuogoData('Giugliano', '10/07/2026')).toBe('Giugliano, lì 10/07/2026')
  })
  it('degrado senza città', () => {
    expect(rigaLuogoData(null, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData(undefined, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData('  ', '10/07/2026')).toBe('Lì 10/07/2026')
  })
})
