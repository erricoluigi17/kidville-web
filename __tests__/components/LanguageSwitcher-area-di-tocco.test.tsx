import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher'

// I pulsanti IT/EN sono alti ~24px: sotto i 44px di area di tocco minima del progetto. L'area si estende con un
// pseudo-elemento di ALTEZZA FISSA (h-11 = 44px) centrato sul pulsante: la pill a vista non cresce e l'area di tocco
// non dipende dal font (il pulsante è alto quanto la sua riga, e il font può cambiare). jsdom non calcola il layout:
// si prova il contratto di classi; la misura vera a 390/320px sta nel rapporto (Chrome, login non autenticata).
describe('LanguageSwitcher: area di tocco di 44px senza far crescere la pill', () => {
  it('ogni pulsante ha un pseudo-elemento alto 44px, centrato, fuori dal flusso', () => {
    render(<LanguageSwitcher />)
    const bottoni = screen.getAllByRole('button')
    expect(bottoni).toHaveLength(2)
    for (const b of bottoni) {
      const c = b.className.split(/\s+/)
      expect(c, 'il pulsante deve essere il riferimento del pseudo-elemento').toContain('relative')
      expect(c).toContain('before:absolute')
      expect(c, '44px = h-11, fissi (non in em: non seguono il font)').toContain('before:h-11')
      expect(c).toContain('before:inset-x-0')
      expect(c, 'centrato in verticale').toContain('before:top-1/2')
      expect(c).toContain('before:-translate-y-1/2')
    }
  })

  it('la pill a vista non cresce: il pulsante resta px-3 py-1 text-xs e il contenitore p-1', () => {
    render(<LanguageSwitcher />)
    const bottoni = screen.getAllByRole('button')
    for (const b of bottoni) {
      expect(b.className).toMatch(/\bpx-3 py-1 font-barlow text-xs\b/)
      // Classi del pulsante stesso (senza prefisso `before:`): nessuna altezza minima, nessun padding verticale più grande.
      const proprie = b.className.split(/\s+/).filter((x) => !x.startsWith('before:'))
      expect(proprie.filter((x) => /^(min-h-|h-|py-(?:2|3|4))/.test(x))).toEqual([])
    }
    expect(bottoni[0].parentElement!.className).toContain('p-1')
  })
})
