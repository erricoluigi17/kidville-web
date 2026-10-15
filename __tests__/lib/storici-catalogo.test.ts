import { describe, expect, it } from 'vitest'
import { CATALOGO_STORICI, espandiCategorie, richiestaStoricoSchema } from '@/lib/storici/catalogo'

const scuolaId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const alunnoId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
describe('catalogo degli storici', () => {
  it('contiene tutte le 55 scelte, uniche, con composizioni esplicite', () => {
    expect(CATALOGO_STORICI).toHaveLength(55)
    expect(new Set(CATALOGO_STORICI.map(c => c.id)).size).toBe(55)
    expect(espandiCategorie(['dossier_completo'])).not.toContain('dossier_completo')
    expect(espandiCategorie(['diario_completo', 'diario_pasti'])).toHaveLength(7)
  })
  it('richiede un solo destinatario e date reali ordinate', () => {
    const richiesta = { scuolaId, alunnoId, dal: '2026-09-01', al: '2026-10-15', categorie: ['diario_completo'], formato: 'pdf' }
    expect(richiestaStoricoSchema.safeParse(richiesta).success).toBe(true)
    expect(richiestaStoricoSchema.safeParse({ ...richiesta, sectionId: scuolaId }).success).toBe(false)
    expect(richiestaStoricoSchema.safeParse({ ...richiesta, alunnoId: undefined }).success).toBe(false)
    expect(richiestaStoricoSchema.safeParse({ ...richiesta, dal: '2026-02-30' }).success).toBe(false)
    expect(richiestaStoricoSchema.safeParse({ ...richiesta, dal: '2026-11-01' }).success).toBe(false)
    expect(richiestaStoricoSchema.safeParse({ ...richiesta, categorie: ['tabella_arbitraria'] }).success).toBe(false)
  })
})
