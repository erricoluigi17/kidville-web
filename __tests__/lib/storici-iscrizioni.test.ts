import { describe, expect, it } from 'vitest'
import { contenutoIscrizione, personeIscrizione } from '@/lib/storici/iscrizioni-collegate'
describe('attribuzione documentale della domanda', () => {
  const data = { children: [{ nome: 'Primo fittizio', documento_path: 'documento-primo.pdf' }, { nome: 'Secondo fittizio', allergies: 'Dato fittizio secondo figlio' }], adults: [{ nome: 'Adulto fittizio', email: 'adulto@example.invalid' }, { nome: 'Altro adulto fittizio' }] }
  it('include solo il figlio e gli adulti esplicitamente indicati', () => {
    const c = contenutoIscrizione(data, 0, [0])!
    expect(c.figlio.nome).toBe('Primo fittizio')
    expect(c.adulti).toHaveLength(1)
    expect(JSON.stringify(c)).not.toContain('secondo figlio')
    expect(JSON.stringify(c)).not.toContain('Altro adulto')
    expect(personeIscrizione(data)).toMatchObject({ figli: [{ indice: 0, nome: 'Primo fittizio' }, { indice: 1, nome: 'Secondo fittizio' }] })
    expect(JSON.stringify(personeIscrizione(data))).not.toContain('allergies')
  })
  it('l’impronta rileva contenuti cambiati, senza dipendere dall’ordine delle chiavi JSON', () => {
    const a = contenutoIscrizione(data, 0, [0])!
    const diversoOrdine = { children: [{ documento_path: 'documento-primo.pdf', nome: 'Primo fittizio' }], adults: [{ email: 'adulto@example.invalid', nome: 'Adulto fittizio' }] }
    expect(contenutoIscrizione(diversoOrdine, 0, [0])!.impronta).toBe(a.impronta)
    const cambiato = structuredClone(data); cambiato.children[0].nome = 'Corretto'
    expect(contenutoIscrizione(cambiato, 0, [0])!.impronta).not.toBe(a.impronta)
  })
  it.each([[null, []], [2, []], [0, [2]], [-1, []]] as Array<[number | null, number[]]>)('rifiuta un’attribuzione non valida %s / %j', (figlio, adulti) => {
    expect(contenutoIscrizione(data, figlio, adulti)).toBeNull()
  })
})
