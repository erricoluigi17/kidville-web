import { describe, it, expect } from 'vitest'
import { buildDocumentoRichiesta, oggettoDocumento } from '@/lib/protocolli/documenti'

const mario = { nome: 'Mario', cognome: 'Rossi', classe_sezione: 'TEST 1A' }

describe('buildDocumentoRichiesta (decisione #22: documenti su richiesta)', () => {
  it('frequenza: riusa il testo certificato esistente', () => {
    const doc = buildDocumentoRichiesta('frequenza', mario, '2025/2026')
    expect(doc.titolo).toBe('CERTIFICATO DI FREQUENZA')
    expect(doc.corpo).toContain("l'alunno/a Rossi Mario")
    expect(doc.corpo).toContain('frequenta regolarmente')
    expect(doc.corpo).toContain('nella sezione TEST 1A')
  })
  it('iscrizione: titolo e testo dedicati', () => {
    const doc = buildDocumentoRichiesta('iscrizione', mario, '2025/2026')
    expect(doc.titolo).toBe('CERTIFICATO DI ISCRIZIONE')
    expect(doc.corpo).toContain('regolarmente iscritto/a')
  })
  it('nulla osta: concessione con alunno, sezione e anno', () => {
    const doc = buildDocumentoRichiesta('nulla_osta', mario, '2025/2026')
    expect(doc.titolo).toBe('NULLA OSTA AL TRASFERIMENTO')
    expect(doc.corpo).toContain('si concede il nulla osta al trasferimento')
    expect(doc.corpo).toContain('Rossi Mario')
    expect(doc.corpo).toContain('nella sezione TEST 1A')
    expect(doc.corpo).toContain("l'anno scolastico 2025/2026")
  })
  it('nulla osta senza sezione: clausola omessa, mai inventata', () => {
    const doc = buildDocumentoRichiesta('nulla_osta', { nome: 'Mario', cognome: 'Rossi' }, '2025/2026')
    expect(doc.corpo).not.toContain('nella sezione')
  })
  it('libero: titolo e corpo passati dalla segreteria', () => {
    const doc = buildDocumentoRichiesta('libero', mario, '2025/2026', {
      titolo: 'Attestazione varia',
      corpo: 'Testo scritto a mano dalla segreteria.',
    })
    expect(doc.titolo).toBe('Attestazione varia')
    expect(doc.corpo).toBe('Testo scritto a mano dalla segreteria.')
  })
  it('libero senza titolo o corpo → errore esplicito', () => {
    expect(() => buildDocumentoRichiesta('libero', mario, '2025/2026', { titolo: ' ', corpo: 'x' }))
      .toThrow()
    expect(() => buildDocumentoRichiesta('libero', mario, '2025/2026')).toThrow()
  })
})

describe('oggettoDocumento (oggetto della registrazione in uscita)', () => {
  it('certificati: tipo + alunno', () => {
    expect(oggettoDocumento('frequenza', mario)).toBe('Certificato di frequenza — Rossi Mario')
    expect(oggettoDocumento('iscrizione', mario)).toBe('Certificato di iscrizione — Rossi Mario')
    expect(oggettoDocumento('nulla_osta', mario)).toBe('Nulla osta al trasferimento — Rossi Mario')
  })
  it('libero: usa il titolo', () => {
    expect(oggettoDocumento('libero', mario, { titolo: 'Attestazione varia', corpo: 'x' })).toBe(
      'Attestazione varia — Rossi Mario'
    )
  })
})
