import { describe, it, expect } from 'vitest'
import { consensiMancanti, CONSENSI_RICHIESTI } from '@/lib/onboarding/consensi'

// P4/DL-045 — onboarding genitore: i consensi GDPR obbligatori devono essere accettati.

describe('consensiMancanti', () => {
  it('nessun mancante se tutti i richiesti sono accettati', () => {
    const accepted = Object.fromEntries(CONSENSI_RICHIESTI.map(k => [k, true]))
    expect(consensiMancanti(accepted, CONSENSI_RICHIESTI)).toEqual([])
  })

  it('ritorna i richiesti non accettati', () => {
    expect(consensiMancanti({ privacy: false }, ['privacy'])).toEqual(['privacy'])
    expect(consensiMancanti({ privacy: true, termini: false }, ['privacy', 'termini'])).toEqual(['termini'])
  })

  it('null/undefined → tutti i richiesti mancano', () => {
    expect(consensiMancanti(null, ['privacy', 'termini'])).toEqual(['privacy', 'termini'])
    expect(consensiMancanti(undefined, ['privacy'])).toEqual(['privacy'])
  })

  it('CONSENSI_RICHIESTI include almeno privacy', () => {
    expect(CONSENSI_RICHIESTI).toContain('privacy')
  })
})
