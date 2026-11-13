import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'

const req = (chiave?: string) => new Request('http://localhost/x', { headers: chiave ? { 'idempotency-key': chiave } : {} })

describe('idempotenza', () => {
  it('legge la chiave solo se ha la forma giusta', () => {
    expect(chiaveIdempotenza(req('conv-123_a-0001'))).toBe('conv-123_a-0001')
    expect(chiaveIdempotenza(req('x'.repeat(8)))).toBe('x'.repeat(8))
    expect(chiaveIdempotenza(req('x'.repeat(128)))).toBe('x'.repeat(128))
    expect(chiaveIdempotenza(req())).toBeNull()
    expect(chiaveIdempotenza(req('x'.repeat(7)))).toBeNull()
    expect(chiaveIdempotenza(req('con spazi dentro'))).toBeNull()
    expect(chiaveIdempotenza(req('chiave.001'))).toBeNull()
    expect(chiaveIdempotenza(req('x'.repeat(129)))).toBeNull()
  })

  it('ordina le chiavi a ogni livello, incluse le chiavi numeriche e __proto__', () => {
    const a = improntaCorpo({ sede: 's', bambini: [{ nome: 'Bimbo Prova', dataNascita: '2023-03-15' }] })
    const b = improntaCorpo({ bambini: [{ dataNascita: '2023-03-15', nome: 'Bimbo Prova' }], sede: 's' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    const canonico = '{"10":null,"2":true,"__proto__":{"a":1,"b":2}}'
    const input = JSON.parse('{"2":true,"10":null,"__proto__":{"b":2,"a":1}}')
    expect(improntaCorpo(input)).toBe(createHash('sha256').update(canonico).digest('hex'))
  })

  it('tiene conto dell’ordine negli array e dei valori', () => {
    expect(improntaCorpo({ x: [1, 2] })).not.toBe(improntaCorpo({ x: [2, 1] }))
    expect(improntaCorpo({ x: 1 })).not.toBe(improntaCorpo({ x: 2 }))
    expect(improntaCorpo({ x: null })).not.toBe(improntaCorpo({}))
  })

  it('accetta valori JSON primitivi e riferimenti condivisi non ciclici', () => {
    expect(improntaCorpo(null)).toBe(createHash('sha256').update('null').digest('hex'))
    const valore = { n: 1 }
    expect(improntaCorpo([valore, valore])).toBe(improntaCorpo([{ n: 1 }, { n: 1 }]))
  })

  it('rifiuta i valori che JSON.stringify scarterebbe o convertirebbe', () => {
    for (const valore of [undefined, BigInt(1), NaN, Infinity, -Infinity, Symbol('x'), () => 1, new Date(0), new Map()]) {
      expect(() => improntaCorpo(valore)).toThrow(TypeError)
      expect(() => improntaCorpo({ valore })).toThrow(TypeError)
      expect(() => improntaCorpo([valore])).toThrow(TypeError)
    }
    expect(() => improntaCorpo(Array(1))).toThrow(TypeError)
    expect(() => improntaCorpo(Object.assign([1], { extra: 2 }))).toThrow(TypeError)
    expect(() => improntaCorpo({ [Symbol('x')]: 1 })).toThrow(TypeError)
    expect(() => improntaCorpo(Object.defineProperty({}, 'x', { value: 1 }))).toThrow(TypeError)
  })

  it('rifiuta i cicli negli oggetti e negli array', () => {
    const oggetto: { figlio?: unknown } = {}
    oggetto.figlio = [oggetto]
    expect(() => improntaCorpo(oggetto)).toThrow(TypeError)
    const array: unknown[] = []
    array.push(array)
    expect(() => improntaCorpo(array)).toThrow(TypeError)
  })

  it('rifiuta gli accessor senza invocarli', () => {
    let letto = false
    const oggetto = {
      get x() {
        letto = true
        return 1
      },
    }
    expect(() => improntaCorpo(oggetto)).toThrow(TypeError)
    expect(letto).toBe(false)
  })
})
