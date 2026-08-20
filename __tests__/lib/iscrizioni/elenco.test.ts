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


// ─────────────────────────────────────────────────────────────────────────────
// LA SECONDA FORMA: LE CLASSI AFFIANCATE DENTRO UN FOGLIO SOLO
//
// Misurata il 2026-08-20 sul file vero di Cesa: UN foglio (`Foglio1`), 13 classi
// affiancate, ognuna larga 4 colonne — numero progressivo, nome, retta, colonna
// vuota — e il nome della classe nella RIGA 1, sopra la colonna dei nomi.
//
// I nomi qui sotto sono INVENTATI: il file vero contiene 255 nomi di bambini e
// non entra nel repository (`*.xlsx` in `.gitignore`).
// ─────────────────────────────────────────────────────────────────────────────
describe('leggiElenco — le classi affiancate in un foglio solo', () => {
  it('legge tre classi affiancate, prendendo la classe dalla riga 1', () => {
    const e = leggiElenco(
      workbook({
        Foglio1: [
          [null, 'NIDO', null, null, null, '2 ANNI A', null, null, null, '3 ANNI B'],
          [1, 'ROSSI MARIO', 300, null, 1, 'VERDI LUCA', 330, null, 1, 'NERI SARA', 180],
          [2, 'BIANCHI ANNA', 300, null, 2, 'GIALLI UGO', 330, null, 2, 'BLU ELIA', 180],
          [3, 'VIOLA IRENE', 300, null, 3, 'GRIGI OLGA', 330, null, 3, 'ROSA TOBIA', 180],
        ],
      }),
    )
    expect(e.righe.map((r) => r.classe)).toEqual([
      'NIDO', 'NIDO', 'NIDO', '2 ANNI A', '2 ANNI A', '2 ANNI A', '3 ANNI B', '3 ANNI B', '3 ANNI B',
    ])
    expect(e.righe.slice(0, 3).map((r) => r.nome)).toEqual(['ROSSI MARIO', 'BIANCHI ANNA', 'VIOLA IRENE'])
    expect(e.righe.map((r) => r.retta)).toEqual([300, 300, 300, 330, 330, 330, 180, 180, 180])
    expect(e.perClasse).toEqual([
      { classe: 'NIDO', alunni: 3 },
      { classe: '2 ANNI A', alunni: 3 },
      { classe: '3 ANNI B', alunni: 3 },
    ])
  })

  it('l\'ultimo blocco non ha la colonna separatrice, e non è un caso speciale', () => {
    const e = leggiElenco(
      workbook({
        Foglio1: [
          [null, 'PRIMA', null, null, null, 'ULTIMA'],
          [1, 'ROSSI MARIO', 300, null, 1, 'VERDI LUCA', 150],
          [2, 'BIANCHI ANNA', 300, null, 2, 'GIALLI UGO', 150],
          [3, 'VIOLA IRENE', 300, null, 3, 'BLU ELIA', 150],
        ],
      }),
    )
    expect(e.righe).toHaveLength(6)
    expect(e.righe[5]).toMatchObject({ classe: 'ULTIMA', nome: 'BLU ELIA', retta: 150 })
  })

  it('i blocchi larghi TRE colonne, senza progressivo, si leggono lo stesso', () => {
    // Il passo non è cablato da nessuna parte: si guarda la colonna a destra.
    const e = leggiElenco(
      workbook({
        Foglio1: [
          ['STRETTA', null, null, 'LARGA'],
          ['ROSSI MARIO', 300, null, 'VERDI LUCA', 330],
          ['BIANCHI ANNA', 300, null, 'GIALLI UGO', 330],
          ['VIOLA IRENE', 300, null, 'BLU ELIA', 330],
        ],
      }),
    )
    expect(e.perClasse).toEqual([
      { classe: 'STRETTA', alunni: 3 },
      { classe: 'LARGA', alunni: 3 },
    ])
  })

  it('IL LOCK DEL DISASTRO: i numeri progressivi non diventano mai alunni', () => {
    // Se il rilevamento della forma sbagliasse sul foglio di Cesa, la colonna dei
    // progressivi verrebbe letta come nomi: ventisette alunni chiamati «1», «2»,
    // «3», e la sede ARMATA con un elenco di spazzatura. Con la guardia «un nome
    // senza lettere non è un nome» lo stesso sbaglio dà zero righe, e la route
    // risponde ELENCO_CLASSI_ILLEGGIBILE.
    const e = leggiElenco(workbook({ Foglio1: [[null, 'NIDO'], [1, 300], [2, 300], [3, 300]] }))
    expect(e.righe).toHaveLength(0)
    expect(e.anomalie.every((a) => a.genere !== 'nome-ripetuto')).toBe(true)
  })

  it('REGRESSIONE FORMA A: la colonna RETTE piena di «vedi fratello» non è una classe', () => {
    // Misurato sul foglio `II` di Giugliano: 21 rette piene, 12 con lettere.
    // Senza la condizione «almeno una cifra a destra» nascerebbero due classi
    // fantasma chiamate `NOME` e `RETTE`, e 22 bambini finirebbero al contrario.
    const e = leggiElenco(
      workbook({
        II: [
          ['NOME', 'RETTE'],
          ['ROSSI MARIO', 'vedi fratello'],
          ['BIANCHI ANNA', 'vedi sorella'],
          ['VIOLA IRENE', 'vedi fr'],
          ['NERI SARA', 150],
        ],
      }),
    )
    expect(e.righe.map((r) => r.classe)).toEqual(['II', 'II', 'II', 'II'])
    expect(e.righe.map((r) => r.nome)).toEqual(['ROSSI MARIO', 'BIANCHI ANNA', 'VIOLA IRENE', 'NERI SARA'])
  })

  it('IL GIRO VERO DELLA SEGRETERIA: il file riscaricato e ricaricato non perde nessuno', () => {
    // `/api/admin/iscrizioni/elenco/export` produce `Alunno | Retta | Stato`, e
    // `Stato` è testo su ogni riga. Ricaricare quel file è il giro previsto —
    // scarica con gli esiti, correggi, ricarica — non un caso limite.
    const e = leggiElenco(
      workbook({
        'I ELEMENTARE': [
          ['Alunno', 'Retta', 'Stato'],
          ['ROSSI MARIO', 150, 'In attesa della domanda'],
          ['BIANCHI ANNA', 150, 'Iscritto'],
          ['VIOLA IRENE', 150, 'In attesa della domanda'],
        ],
      }),
    )
    expect(e.perClasse).toEqual([{ classe: 'I ELEMENTARE', alunni: 3 }])
    expect(e.righe.map((r) => r.retta)).toEqual([150, 150, 150])
  })

  it('due intestazioni in A1 e B1 restano UNA classe, comunque siano scritte', () => {
    // Le intestazioni sono quelle eterogenee misurate sul file vero di Giugliano:
    // una regola che guardasse il TESTO fallirebbe su ognuna.
    const e = leggiElenco(
      workbook({
        'MICRONIDO': [['NOME ', 'RETTA'], ['ROSSI MARIO', 330]],
        '4 anni  a': [['nomedn', 'RETTA'], ['VERDI LUCA', 180]],
        '4 anni b': [['Colonna 1', 'retta'], ['NERI SARA', 150]],
        '5 anni a': [['nome', 'RETTA SETT'], ['GIALLI UGO', 100]],
        '5 anni b': [['1', 'RETTA'], ['BLU ELIA', 120]],
      }),
    )
    expect(e.righe.map((r) => r.classe)).toEqual([
      'MICRONIDO', '4 anni  a', '4 anni b', '5 anni a', '5 anni b',
    ])
    expect(e.righe.map((r) => r.nome)).toEqual([
      'ROSSI MARIO', 'VERDI LUCA', 'NERI SARA', 'GIALLI UGO', 'BLU ELIA',
    ])
  })

  it('una cella di riga 1 senza niente sotto è un\'annotazione, non una classe', () => {
    const e = leggiElenco(
      workbook({
        'II': [['NOME', 'RETTA', null, null, 'aggiornato al 10/09'], ['ROSSI MARIO', 150]],
      }),
    )
    expect(e.perClasse).toEqual([{ classe: 'II', alunni: 1 }])
  })

  it('le difformità valgono anche a blocchi, e dicono in quale CELLA guardare', () => {
    const e = leggiElenco(
      workbook({
        Foglio1: [
          [null, 'PRIMA', null, null, null, 'SECONDA'],
          [1, 'ROSSI MARIO', null, null, 1, 'VERDI LUCA', 'X'],
          [2, 'BIANCHI ANNA', 300, null, 2, 'GIALLI UGO', 330],
          [3, 'VIOLA IRENE', 300, null, 3, 'BLU ELIA', 330],
        ],
      }),
    )
    const mancante = e.anomalie.find((a) => a.genere === 'retta-mancante')
    expect(mancante).toMatchObject({ classe: 'PRIMA', rigaExcel: 2 })
    const nonNumerica = e.anomalie.find((a) => a.genere === 'retta-non-numerica')
    expect(nonNumerica).toMatchObject({ classe: 'SECONDA', rigaExcel: 2 })
    // La posizione COMPLETA: con le classi affiancate «riga 2» non basta a
    // ritrovare la cella, e la cella da correggere è quella della retta.
    expect(mancante!.dettaglio).toMatch(/C2/)
    expect(nonNumerica!.dettaglio).toMatch(/G2/)
  })

  it('una colonna di nomi senza classe sopra NON viene persa in silenzio', () => {
    const e = leggiElenco(
      workbook({
        Foglio1: [
          [null, 'PRIMA', null, null, null, 'SECONDA', null, null, null, null],
          [1, 'ROSSI MARIO', 300, null, 1, 'VERDI LUCA', 330, null, 1, 'GRIGI OLGA', 200],
          [2, 'BIANCHI ANNA', 300, null, 2, 'GIALLI UGO', 330, null, 2, 'ROSA TOBIA', 200],
          [3, 'VIOLA IRENE', 300, null, 3, 'BLU ELIA', 330, null, 3, 'ARANCI IVO', 200],
        ],
      }),
    )
    const orfana = e.anomalie.find((a) => a.genere === 'colonna-senza-classe')
    expect(orfana).toBeDefined()
    expect(orfana!.dettaglio).toMatch(/colonna J/)
    expect(orfana!.dettaglio).toMatch(/3 valori/)
  })

  it('la barra rovescia nel nome della classe si raddrizza, e lo dichiara', () => {
    const e = leggiElenco(
      workbook({
        Foglio1: [
          [null, 'NIDO 2026\\2027', null, null, null, 'ALTRA'],
          [1, 'ROSSI MARIO', 300, null, 1, 'VERDI LUCA', 330],
          [2, 'BIANCHI ANNA', 300, null, 2, 'GIALLI UGO', 330],
          [3, 'VIOLA IRENE', 300, null, 3, 'BLU ELIA', 330],
        ],
      }),
    )
    expect(e.righe[0].classe).toBe('NIDO 2026/2027')
    const a = e.anomalie.find((x) => x.genere === 'classe-riscritta')
    expect(a).toBeDefined()
    expect(a!.dettaglio).toMatch(/NIDO 2026\/2027/)
  })
})
