// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isScuolaE2E } from '@/lib/scuole/reali'
import {
  SEDE_A,
  SEDE_B,
  SEDE_C,
  SEDE_E2E,
  NOME_SEDE_A,
  NOME_SEDE_B,
  NOME_SEDE_C,
  NOME_SEDE_E2E,
} from './sedi'

/**
 * Contratto della fixture delle sedi.
 *
 * Un test non deve conoscere la produzione: fino al 2026-07-31 l'uuid REALE di
 * Giugliano era incollato in 24 file di test, dove era indistinguibile da uno
 * finto. Se domani quell'uuid cambia — o se qualcuno lo copia da un test per
 * incollarlo in una migrazione — i test devono restare veri lo stesso.
 *
 * Qui si verifica l'unica cosa che la fixture deve garantire per essere
 * utilizzabile: che le sedi finte siano DISTINTE fra loro e che il predicato di
 * produzione `isScuolaE2E` le classifichi come ci si aspetta — le tre sedi
 * ordinarie REALI, la quarta di TEST. La forma dell'uuid E2E (prefisso
 * `e2e00000`) non è decorativa: è il segnale su cui si regge l'esclusione della
 * sede finta da ogni elenco pubblico.
 */
describe('fixture sedi — uuid finti, semantica vera', () => {
  it('le quattro sedi sono uuid distinti e ben formati', () => {
    const ids = [SEDE_A, SEDE_B, SEDE_C, SEDE_E2E]
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(ids).size).toBe(4)
  })

  it('SEDE_E2E è riconosciuta come sede di TEST dal predicato di produzione', () => {
    expect(isScuolaE2E({ id: SEDE_E2E, nome: 'Scuola di prova' })).toBe(true)
    expect(isScuolaE2E({ id: SEDE_A, nome: NOME_SEDE_E2E })).toBe(true)
  })

  it('SEDE_A, SEDE_B e SEDE_C valgono come sedi REALI (non di test)', () => {
    expect(isScuolaE2E({ id: SEDE_A, nome: NOME_SEDE_A })).toBe(false)
    expect(isScuolaE2E({ id: SEDE_B, nome: NOME_SEDE_B })).toBe(false)
    expect(isScuolaE2E({ id: SEDE_C, nome: NOME_SEDE_C })).toBe(false)
  })

  it('i nomi sono distinti e in ordine alfabetico crescente A → B → C', () => {
    const nomi = [NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C]
    expect(new Set(nomi).size).toBe(3)
    expect([...nomi].sort((x, y) => x.localeCompare(y, 'it'))).toEqual(nomi)
  })
})
