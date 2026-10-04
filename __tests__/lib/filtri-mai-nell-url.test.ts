import { describe, it, expect } from 'vitest'
import { parametriGovernati, valoriIniziali, versoUrl } from '@/lib/ui/filtri/motore'
import type { CampoFiltro } from '@/lib/ui/filtri/tipi'

// La ricerca per nome dell'anagrafica docente porta il NOME di un bambino: non deve
// finire nell'indirizzo, che il service worker usa come chiave di cache su disco e che
// i log di accesso registrano. Gli altri filtri restano nell'URL come sempre.

interface Riga {
  nome: string
  classe: string
}

const campi: CampoFiltro<Riga>[] = [
  { tipo: 'ricerca', chiave: 'q', etichetta: 'Cerca', dove: 'client', maiNellUrl: true, testiDi: (r) => [r.nome] },
  {
    tipo: 'scelta',
    chiave: 'classe',
    etichetta: 'Classe',
    dove: 'client',
    opzioni: [{ valore: 'A', etichetta: 'A' }],
    valoreDi: (r) => r.classe,
  },
]

describe('motore filtri — `maiNellUrl`', () => {
  it('il campo non esce nell’indirizzo, gli altri sì', () => {
    const p = versoUrl(campi, { q: 'Rossi', classe: 'A' })
    expect(p.get('q')).toBeNull()
    expect(p.get('classe')).toBe('A')
  })

  it('il campo non si legge dall’indirizzo, gli altri sì', () => {
    const v = valoriIniziali(campi, new URLSearchParams('q=Rossi&classe=A'))
    expect(v.q).toBe('')
    expect(v.classe).toBe('A')
  })

  it('resta GOVERNATO: un `q` arrivato nell’indirizzo la barra lo cancella', () => {
    expect(parametriGovernati(campi)).toContain('q')
  })

  it('CONTROLLO POSITIVO — senza il flag la ricerca esce e si legge come prima', () => {
    const senza = campi.map((c) => (c.chiave === 'q' ? { ...c, maiNellUrl: undefined } : c)) as CampoFiltro<Riga>[]
    expect(versoUrl(senza, { q: 'Rossi', classe: '' }).get('q')).toBe('Rossi')
    expect(valoriIniziali(senza, new URLSearchParams('q=Rossi')).q).toBe('Rossi')
  })
})
