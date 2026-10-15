// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { pianoGiorniSeedE2E } from '../../scripts/lib/seed-e2e-giornate.mjs'

// Legge esclusivamente il letterale degli UUID: non importa il seed che carica .env.
const source = readFileSync(new URL('../../scripts/seed-e2e.mjs', import.meta.url), 'utf8')
const letterale = /export const IDS = (\{[\s\S]*?\n\});/.exec(source)?.[1]
if (!letterale) throw new Error('Letterale degli UUID del seed non trovato')
const ids = runInNewContext(`(${letterale})`) as Record<string, string>
const piatti = { primoSede1: 'Primo della sede 1', primoSede2: 'Primo della sede 2' }
const piano = (istante: string) => pianoGiorniSeedE2E(new Date(istante), ids, piatti)

describe('seed E2E — continuità del giorno romano senza cambiare le asserzioni', () => {
  it('seed del 15 alle 23:59:42 Roma: dashboard e mensa del 16 trovano gli stessi dati', () => {
    const dati = piano('2026-10-15T21:59:42Z')
    expect(dati.giorni).toEqual(['2026-10-15', '2026-10-16'])
    for (const giorno of ['2026-10-15', '2026-10-16']) {
      const presenze = dati.presenze.filter(r => r.data === giorno)
      expect(presenze).toEqual([
        { alunno_id: ids.A3, data: giorno, stato: 'presente', orario_entrata: '08:45', scuola_id: ids.SCUOLA, section_id: ids.SEC_TULIPANI },
        { alunno_id: ids.A4, data: giorno, stato: 'assente', scuola_id: ids.SCUOLA, section_id: ids.SEC_TULIPANI },
      ])
      expect(presenze.filter(r => r.stato === 'presente').length / 5 * 100).toBe(20)
      const menu = dati.menu.filter(r => r.data === giorno)
      expect(menu.map(r => ({ sede: r.scuola_id, primo: r.portate.primo }))).toEqual([
        { sede: ids.SCUOLA, primo: piatti.primoSede1 }, { sede: ids.SCUOLA2, primo: piatti.primoSede2 },
      ])
      expect(menu.every(r => r.menu_config_id === null && r.chiuso === false)).toBe(true)
    }
    expect(dati.presenze).toHaveLength(4)
    expect(dati.menu).toHaveLength(4)
  })

  it.each([
    ['2026-03-28T23:30:00Z', '2026-03-29', '2026-03-30', 23],
    ['2026-10-24T22:30:00Z', '2026-10-25', '2026-10-26', 25],
  ])('cambio d’ora da %s: %s → %s, giornata di %i ore', (istante, oggi, domani, ore) => {
    const mezzanotte = oggi === '2026-03-29' ? '2026-03-28T23:00:00Z' : '2026-10-24T22:00:00Z'
    const successiva = oggi === '2026-03-29' ? '2026-03-29T22:00:00Z' : '2026-10-25T23:00:00Z'
    expect((Date.parse(successiva) - Date.parse(mezzanotte)) / 3_600_000).toBe(ore)
    const dati = piano(istante)
    expect(dati.giorni).toEqual([oggi, domani])
    expect(dati.presenze.map(r => r.data)).toEqual([oggi, oggi, domani, domani])
    expect(dati.menu.map(r => r.data)).toEqual([oggi, oggi, domani, domani])
  })

  it('la vigilia del cambio primaverile alle 23:30 non salta il giorno successivo', () => {
    expect(piano('2026-03-28T22:30:00Z').giorni).toEqual(['2026-03-28', '2026-03-29'])
  })

  it.each([
    ['2026-12-31T22:59:59Z', '2026-12-31', '2027-01-01'],
    ['2028-02-28T23:30:00Z', '2028-02-29', '2028-03-01'],
  ])('rollover mese/anno da %s', (istante, oggi, domani) => {
    expect(piano(istante).giorni).toEqual([oggi, domani])
  })

  it('il piano è idempotente e conserva gli UUID menu del primo giorno', () => {
    const dati = piano('2026-10-15T21:59:42Z')
    expect(piano('2026-10-15T21:59:42Z')).toEqual(dati)
    expect(dati.menu.slice(0, 2).map(r => r.id)).toEqual(['e2e00000-0000-4000-8000-000000001101', 'e2e00000-0000-4000-8000-000000001102'])
    expect(new Set(dati.menu.map(r => r.id)).size).toBe(4)
    expect(new Set(dati.menu.map(r => `${r.scuola_id}/${r.data}`)).size).toBe(4)
  })

  it('i due nuovi UUID menu sono validi e non collidono con nessun altro UUID del seed', () => {
    expect(ids.MENU_OVR_S1_DOMANI).toBe('e2e00000-0000-4000-8000-000000001103')
    expect(ids.MENU_OVR_S2_DOMANI).toBe('e2e00000-0000-4000-8000-000000001104')
    for (const id of [ids.MENU_OVR_S1_DOMANI, ids.MENU_OVR_S2_DOMANI]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(Object.values(ids).filter(v => v === id)).toHaveLength(1)
    }
  })
})
