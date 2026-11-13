import { describe, expect, it } from 'vitest'
import { FORMA_TOKEN, generaToken, improntaToken, tokenDaRichiesta } from '@/lib/crm/ai/token'

const req = (auth?: string) => new Request('http://localhost/x', { headers: auth ? { authorization: auth } : {} })
const FINTO = 'kvai_' + 'A'.repeat(43)

describe('token dell’assistente', () => {
  it('genera un token di 32 byte con la sua impronta e la sua coda', () => {
    const t = generaToken()
    expect(t.token).toMatch(FORMA_TOKEN)
    expect(Buffer.from(t.token.slice(5), 'base64url')).toHaveLength(32)
    expect(t.impronta).toBe(improntaToken(t.token))
    expect(t.impronta).toMatch(/^[0-9a-f]{64}$/)
    expect(t.coda).toBe(t.token.slice(-4))
    expect(generaToken().token).not.toBe(t.token)
  })

  it('l’impronta è lo SHA-256 esadecimale', () => {
    expect(improntaToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it.each(['Bearer', 'bearer', 'bEaReR'])('accetta lo schema %s', (schema) => {
    expect(tokenDaRichiesta(req(`${schema} ${FINTO}`))).toBe(FINTO)
  })

  it.each([
    undefined,
    FINTO,
    'Bearer kvai_corto',
    `Bearer KVAI_${'A'.repeat(43)}`,
    `Bearer  ${FINTO}`,
    `Bearer\t${FINTO}`,
    `Bearer ${FINTO} altro`,
    `Bearer ${FINTO}, Bearer ${FINTO}`,
    `Basic ${FINTO}`,
  ])('rifiuta l’autorizzazione malformata: %s', (header) => {
    expect(tokenDaRichiesta(req(header))).toBeNull()
  })
})
