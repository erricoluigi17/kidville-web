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

  it('resta GOVERNATO: è fra i parametri che la barra riscrive (e quindi toglie)', () => {
    expect(parametriGovernati(campi)).toContain('q')
  })

  it('CONTROLLO POSITIVO — senza il flag la ricerca esce e si legge come prima', () => {
    const senza = campi.map((c) => (c.chiave === 'q' ? { ...c, maiNellUrl: undefined } : c)) as CampoFiltro<Riga>[]
    expect(versoUrl(senza, { q: 'Rossi', classe: '' }).get('q')).toBe('Rossi')
    expect(valoriIniziali(senza, new URLSearchParams('q=Rossi')).q).toBe('Rossi')
  })

  it('vale anche per un campo `multi` e per un `periodo` (`<chiave>Da`/`<chiave>A`)', () => {
    const altri: CampoFiltro<Riga>[] = [
      {
        tipo: 'multi',
        chiave: 'tag',
        etichetta: 'Tag',
        dove: 'client',
        maiNellUrl: true,
        opzioni: [
          { valore: 'A', etichetta: 'A' },
          { valore: 'B', etichetta: 'B' },
        ],
        valoriDi: (r) => [r.classe],
      },
      {
        tipo: 'periodo',
        chiave: 'dal',
        etichetta: 'Periodo',
        dove: 'client',
        maiNellUrl: true,
        dataDi: () => '2026-01-01',
      },
    ]
    const p = versoUrl(altri, { tag: ['A', 'B'], dal: { da: '2026-01-01', a: '2026-03-31' } })
    expect([...p.keys()]).toEqual([])

    const v = valoriIniziali(altri, new URLSearchParams('tag=A&tag=B&tag=A,B&dalDa=2026-01-01&dalA=2026-03-31'))
    expect(v.tag).toEqual([])
    expect(v.dal).toEqual({ da: '', a: '' })

    expect(parametriGovernati(altri)).toEqual(expect.arrayContaining(['tag', 'dalDa', 'dalA']))
  })
})
