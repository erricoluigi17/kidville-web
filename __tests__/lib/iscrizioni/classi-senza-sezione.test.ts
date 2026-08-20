import { describe, it, expect } from 'vitest'
import { anomalieClassiSenzaSezione } from '@/lib/iscrizioni/import/sezioni'

// ─────────────────────────────────────────────────────────────────────────────
// LA CLASSE CHE NON HA UNA SEZIONE — e che oggi non lo dice a nessuno.
//
// `alunni.classe_sezione` si scrive come TESTO, e a risolvere `section_id` è il
// trigger `sync_alunno_section_id`. Se il nome non combacia, il trigger lascia
// NULL **senza errore**: il bambino viene iscritto e non compare in nessun
// appello, in nessun registro, in nessuna classe. Nessun test lo vedeva.
//
// Misurato in produzione il 2026-08-20 sul foglio vero di Cesa: 3 classi su 13
// non hanno una sezione omonima, e valgono 66 bambini.
// ─────────────────────────────────────────────────────────────────────────────
describe('anomalieClassiSenzaSezione', () => {
  const perClasse = (...v: [string, number][]) => v.map(([classe, alunni]) => ({ classe, alunni }))

  it('la classe senza sezione diventa un\'anomalia che dice QUANTI bambini valgono', () => {
    const a = anomalieClassiSenzaSezione(perClasse(['2 ANNI CONCY', 16]), ['2 ANNI', '3 ANNI LUCIA'])
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ genere: 'classe-senza-sezione', classe: '2 ANNI CONCY' })
    // Il numero è ciò che fa agire: «una classe non combacia» non muove nessuno,
    // «sedici bambini resterebbero senza classe» sì.
    expect(a[0].dettaglio).toMatch(/16/)
  })

  it('maiuscole e spazi non contano — è la formula del trigger, non una a senso', () => {
    const a = anomalieClassiSenzaSezione(
      perClasse(['4 ANNI M.ROSARIA', 19], ['I ELEMENTARE', 23]),
      ['4 anni m.rosaria', 'IELEMENTARE'],
    )
    expect(a).toHaveLength(0)
  })

  it('IL PUNTO E LA BARRA CONTANO, perché il trigger non li toglie', () => {
    // Usare `normalizzaNome` al posto della formula del trigger farebbe
    // combaciare questi due — e il trigger poi non li risolverebbe: il difetto
    // tornerebbe identico e muto.
    expect(anomalieClassiSenzaSezione(perClasse(['4 ANNI M.ROSARIA', 19]), ['4 ANNI MROSARIA'])).toHaveLength(1)
    expect(anomalieClassiSenzaSezione(perClasse(['NIDO 2026/2027', 24]), ['NIDO 2026\\2027'])).toHaveLength(1)
  })

  it('nessuna sezione letta ⇒ NESSUNA anomalia, non una per classe', () => {
    // Su un archivio che non risponde (o su un DB non migrato) gridare su ogni
    // classe sarebbe rumore che nasconde il segnale.
    expect(anomalieClassiSenzaSezione(perClasse(['A', 1], ['B', 2]), [])).toHaveLength(0)
  })

  it('le tre classi vere di Cesa, con i conteggi veri del foglio', () => {
    const a = anomalieClassiSenzaSezione(
      perClasse(
        ['NIDO 2026/2027', 24], ['2 ANNI CONCY', 16], ['2 ANNI AMALIA', 27],
        ['3 ANNI LUCIA', 22], ['5 ANNI GIUSY', 23], ['I ELEMENTARE', 23],
      ),
      ['NIDO 2026/2027', '2 ANNI', '3 ANNI LUCIA', '5 ANNI', 'I ELEMENTARE'],
    )
    expect(a.map((x) => x.classe)).toEqual(['2 ANNI CONCY', '2 ANNI AMALIA', '5 ANNI GIUSY'])
  })

  it('SE LA BARRA NON FOSSE RADDRIZZATA le classi scoperte sarebbero quattro', () => {
    // È il lock che lega la riscrittura della barra (in `elenco.ts`) a questa
    // guardia: senza quella, 24 bambini del nido restano fuori.
    const a = anomalieClassiSenzaSezione(perClasse(['NIDO 2026\\2027', 24]), ['NIDO 2026/2027'])
    expect(a).toHaveLength(1)
  })
})
