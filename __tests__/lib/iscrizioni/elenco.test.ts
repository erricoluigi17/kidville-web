import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { leggiElenco } from '@/lib/iscrizioni/import/elenco'

// ─────────────────────────────────────────────────────────────────────────────
// LA LETTURA DELL'ELENCO DI CLASSE
//
// I fogli qui sotto sono costruiti a mano e con nomi INVENTATI: il file vero
// contiene 338 nomi di bambini e non entra nel repository (`.gitignore`, e il
// lock `pii-nei-file-tracciati`). Ma la FORMA è quella misurata sul file vero il
// 2026-08-16, difformità comprese — intestazione, annotazione a lato, rette
// vuote, rimandi, spazi doppi, il `?` al posto della cifra.
// ─────────────────────────────────────────────────────────────────────────────

function workbook(fogli: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const [nome, righe] of Object.entries(fogli)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(righe), nome)
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
}

describe('leggiElenco — il nome del foglio è la classe', () => {
  it('legge nome e retta, saltando l\'intestazione', () => {
    const e = leggiElenco(
      workbook({
        MICRONIDO: [
          ['NOME ', 'RETTA'],
          ['ROSSI MARIO', 330],
          ['BIANCHI ANNA', 480],
        ],
      }),
    )
    expect(e.righe).toHaveLength(2)
    expect(e.righe[0]).toMatchObject({ classe: 'MICRONIDO', nome: 'ROSSI MARIO', retta: 330, rigaExcel: 2 })
    expect(e.perClasse).toEqual([{ classe: 'MICRONIDO', alunni: 2 }])
  })

  it('tiene insieme più fogli, ognuno con la sua classe', () => {
    const e = leggiElenco(
      workbook({
        'MICRONIDO': [['NOME', 'RETTA'], ['ROSSI MARIO', 330]],
        '4 anni  a': [['nomedn', 'RETTA'], ['VERDI LUCA', 180]],
        'II': [['NOME', 'RETTE'], ['NERI SARA', 150]],
      }),
    )
    expect(e.righe.map((r) => r.classe)).toEqual(['MICRONIDO', '4 anni  a', 'II'])
  })

  it('ignora l\'annotazione «nome classe= sez. …» che sta a lato', () => {
    const e = leggiElenco(
      workbook({
        MICRONIDO: [
          ['NOME', 'RETTA'],
          ['ROSSI MARIO', 330, null, 'nome classe= sez. delle meraviglie'],
        ],
      }),
    )
    expect(e.righe).toHaveLength(1)
    expect(e.righe[0].nome).toBe('ROSSI MARIO')
  })

  it('una cifra scritta come testo resta una cifra', () => {
    const e = leggiElenco(
      workbook({ MICRONIDO: [['NOME', 'RETTA'], ['ROSSI MARIO', ' 330 '], ['VERDI LUCA', '180,50']] }),
    )
    expect(e.righe[0].retta).toBe(330)
    expect(e.righe[1].retta).toBe(180.5)
  })

  it('il rimando al fratello resta testo, e non è un\'anomalia da correggere', () => {
    const e = leggiElenco(
      workbook({ '5 anni b': [['NOME', 'RETTA'], ['ROSSI LUCA', 'vedi fratello']] }),
    )
    expect(e.righe[0]).toMatchObject({ retta: null, rettaTesto: 'vedi fratello' })
    expect(e.anomalie.filter((a) => a.genere === 'retta-non-numerica')).toHaveLength(0)
  })
})

describe('leggiElenco — le difformità si mostrano, non si correggono', () => {
  it('segnala la retta mancante', () => {
    const e = leggiElenco(workbook({ III: [['NOME', 'RETTA'], ['ROSSI MARIO', null]] }))
    const a = e.anomalie.find((x) => x.genere === 'retta-mancante')
    expect(a).toBeDefined()
    expect(a!.dettaglio).toMatch(/ROSSI MARIO/)
    // la riga c'è comunque: il file si mostra com'è
    expect(e.righe).toHaveLength(1)
  })

  it('segnala un «?» al posto della cifra', () => {
    const e = leggiElenco(workbook({ II: [['NOME', 'RETTE'], ['ROSSI MARIO', '?']] }))
    expect(e.anomalie.some((x) => x.genere === 'retta-non-numerica')).toBe(true)
  })

  it('segnala il nome senza retta accanto (riga che ha perso il nome)', () => {
    const e = leggiElenco(workbook({ II: [['NOME', 'RETTE'], [null, 150]] }))
    expect(e.anomalie.some((x) => x.genere === 'nome-mancante')).toBe(true)
    expect(e.righe).toHaveLength(0)
  })

  it('segnala gli spazi di troppo, senza scartare la riga', () => {
    const e = leggiElenco(workbook({ MICRONIDO: [['NOME', 'RETTA'], ['MIRAGLIA  ANIELLO ', 330]] }))
    expect(e.anomalie.some((x) => x.genere === 'spazi-anomali')).toBe(true)
    expect(e.righe[0].nomeNorm).toBe('MIRAGLIA ANIELLO')
  })

  it('segnala lo stesso nome in due fogli diversi, e dice dove', () => {
    const e = leggiElenco(
      workbook({
        '2 ANNI B': [['NOME', 'RETTA'], ['PALMA ANDREA', 300]],
        '2 ANNI C': [['NOME', 'RETTA'], ['PALMA ANDREA', 300]],
      }),
    )
    const ripetuti = e.anomalie.filter((x) => x.genere === 'nome-ripetuto')
    expect(ripetuti).toHaveLength(2)
    expect(ripetuti[0].dettaglio).toMatch(/2 ANNI B/)
    expect(ripetuti[0].dettaglio).toMatch(/2 ANNI C/)
  })

  it('segnala la retta lontana da quella prevalente, dicendo che non blocca niente', () => {
    const e = leggiElenco(
      workbook({
        '3 ANNI A': [
          ['NOME', 'RETTA'],
          ['A A', 180], ['B B', 180], ['C C', 180], ['D D', 180], ['E E', 330],
        ],
      }),
    )
    const a = e.anomalie.find((x) => x.genere === 'retta-fuori-scala')
    expect(a).toBeDefined()
    expect(a!.dettaglio).toMatch(/330/)
    expect(a!.dettaglio).toMatch(/non blocca/i)
  })

  it('con poche righe non parla di «prevalente»: non inventa una scala', () => {
    const e = leggiElenco(workbook({ V: [['NOME', 'RETTA'], ['A A', 150], ['B B', 100]] }))
    expect(e.anomalie.filter((x) => x.genere === 'retta-fuori-scala')).toHaveLength(0)
  })

  it('un foglio vuoto non produce righe né esplode', () => {
    const e = leggiElenco(workbook({ IV: [['NOME', 'RETTA']] }))
    expect(e.righe).toHaveLength(0)
    expect(e.perClasse).toEqual([{ classe: 'IV', alunni: 0 }])
  })
})
