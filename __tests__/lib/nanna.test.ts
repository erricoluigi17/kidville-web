import { describe, it, expect } from 'vitest'
import { oraNanna, nannaCompilata, eEventoNanna } from '@/lib/diary/nanna'

// L'estrattore condiviso teacher/parent per la nanna, gemello di `umore.ts`.
//
// IL DIFETTO CHE LO FA NASCERE. Il salvataggio del diario aveva UN SOLO ramo
// selettivo (`umore`): «Nanna» e «Sveglia» scrivevano una riga in `eventi_diario`
// per OGNI bambino presente, anche con `dettagli.orario_inizio = ''`. Il genitore
// di un bambino che non aveva dormito leggeva «Ho fatto un bel sonnellino! 😴».
//
// Il punto di queste asserzioni è UNO: `''` non è un'ora. Da qui lo sanno tutti e
// tre i lettori — chi salva, chi rimette la ✅, chi racconta al genitore — invece
// di ricordarselo ognuno per conto proprio.

describe('nanna — estrattore condiviso', () => {
  describe('oraNanna', () => {
    it('legge l\'ora quando c\'è', () => {
      expect(oraNanna({ orario_inizio: '13:05' }, 'orario_inizio')).toBe('13:05')
      expect(oraNanna({ orario_fine: '15:30' }, 'orario_fine')).toBe('15:30')
    })

    it('la stringa vuota NON è un\'ora', () => {
      expect(oraNanna({ orario_inizio: '' }, 'orario_inizio')).toBeNull()
    })

    it('i soli spazi NON sono un\'ora', () => {
      expect(oraNanna({ orario_inizio: '   ' }, 'orario_inizio')).toBeNull()
    })

    it('assente, null, non-stringa → null', () => {
      expect(oraNanna({}, 'orario_inizio')).toBeNull()
      expect(oraNanna(null, 'orario_inizio')).toBeNull()
      expect(oraNanna(undefined, 'orario_inizio')).toBeNull()
      expect(oraNanna({ orario_inizio: null }, 'orario_inizio')).toBeNull()
      expect(oraNanna({ orario_inizio: 1300 }, 'orario_inizio')).toBeNull()
    })

    it('non confonde i due campi', () => {
      expect(oraNanna({ orario_fine: '15:00' }, 'orario_inizio')).toBeNull()
      expect(oraNanna({ orario_inizio: '13:00' }, 'orario_fine')).toBeNull()
    })
  })

  describe('eEventoNanna', () => {
    it('riconosce i tre tipi, e solo quelli', () => {
      expect(eEventoNanna('nanna_inizio')).toBe(true)
      expect(eEventoNanna('nanna_fine')).toBe(true)
      // `nanna` è il tipo storico: compare ancora nelle righe vecchie e nella
      // narrativa del genitore. Se lo si dimenticasse, l'archivio resterebbe
      // pieno di sonnellini mai avvenuti.
      expect(eEventoNanna('nanna')).toBe(true)
      expect(eEventoNanna('pranzo')).toBe(false)
      expect(eEventoNanna('bagno')).toBe(false)
      expect(eEventoNanna('umore')).toBe(false)
      expect(eEventoNanna('')).toBe(false)
    })
  })

  describe('nannaCompilata', () => {
    it('nanna_inizio guarda l\'inizio', () => {
      expect(nannaCompilata('nanna_inizio', { orario_inizio: '13:00' })).toBe(true)
      expect(nannaCompilata('nanna_inizio', { orario_inizio: '' })).toBe(false)
      expect(nannaCompilata('nanna_inizio', { orario_fine: '15:00' })).toBe(false)
    })

    it('nanna_fine guarda la fine', () => {
      expect(nannaCompilata('nanna_fine', { orario_fine: '15:00' })).toBe(true)
      expect(nannaCompilata('nanna_fine', { orario_fine: '' })).toBe(false)
      expect(nannaCompilata('nanna_fine', { orario_inizio: '13:00' })).toBe(false)
    })

    it('al tipo storico `nanna` basta uno dei due', () => {
      expect(nannaCompilata('nanna', { orario_inizio: '13:00' })).toBe(true)
      expect(nannaCompilata('nanna', { orario_fine: '15:00' })).toBe(true)
      expect(nannaCompilata('nanna', { orario_inizio: '', orario_fine: '' })).toBe(false)
    })

    it('è fail-closed: dettagli assenti o tipo estraneo → false', () => {
      expect(nannaCompilata('nanna_inizio', null)).toBe(false)
      expect(nannaCompilata('nanna_inizio', undefined)).toBe(false)
      expect(nannaCompilata('nanna_inizio', {})).toBe(false)
      expect(nannaCompilata('pranzo', { orario_inizio: '13:00' })).toBe(false)
    })
  })
})
