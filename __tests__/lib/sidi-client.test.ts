import { describe, it, expect } from 'vitest'
import { resolveSidiCredentials, sidiBaseUrls, sidiTransmit } from '@/lib/sidi/client'

describe('resolveSidiCredentials', () => {
  it('null quando le credenziali sono incomplete', () => {
    expect(resolveSidiCredentials({})).toBeNull()
    expect(resolveSidiCredentials({ username: 'u', codice_meccanografico: 'RMIC' })).toBeNull()
  })

  it('risolve la password dalla env indicata da password_ref', () => {
    process.env.SIDI_TEST_PW = 'segreta'
    const creds = resolveSidiCredentials({ username: 'u', password_ref: 'SIDI_TEST_PW', codice_meccanografico: 'RMIC' })
    expect(creds).toEqual({ username: 'u', password: 'segreta', codiceMeccanografico: 'RMIC' })
    delete process.env.SIDI_TEST_PW
  })
})

describe('sidiBaseUrls', () => {
  it('seleziona demo o produzione', () => {
    expect(sidiBaseUrls('demo').ws).toMatch(/demo/i)
    expect(sidiBaseUrls('production').ws).not.toMatch(/demo/i)
  })
})

describe('sidiTransmit — boundary gated', () => {
  it('503 non_configurato quando non abilitato o senza credenziali', async () => {
    const r = await sidiTransmit({ abilitato: false }, 'fase_a', '<xml/>')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('non_configurato')
      expect(r.httpStatus).toBe(503)
    }
  })

  it('503 non_accreditato quando configurato ma accreditamento ministeriale assente', async () => {
    process.env.SIDI_TEST_PW = 'x'
    const r = await sidiTransmit(
      { abilitato: true, username: 'u', password_ref: 'SIDI_TEST_PW', codice_meccanografico: 'RMIC' },
      'frequentanti',
      '<xml/>'
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('non_accreditato')
      expect(r.httpStatus).toBe(503)
    }
    delete process.env.SIDI_TEST_PW
  })
})
