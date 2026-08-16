import { describe, it, expect } from 'vitest'
import {
  normalizzaNome,
  senzaSpazi,
  tokenNome,
  similitudine,
} from '@/lib/iscrizioni/import/normalizza'
import { abbina, type RigaElenco } from '@/lib/iscrizioni/import/abbinamento'

// ─────────────────────────────────────────────────────────────────────────────
// L'ABBINAMENTO NOME → CLASSE
//
// Ogni caso qui sotto è STATO MISURATO il 2026-08-16 sul file vero
// `ISCRIZIONE 26_27 Giugliano.xlsx` (338 righe) e sulle 221 domande di Giugliano
// già in `enrollment_submissions`. Non sono esempi inventati: sono le difformità
// che esistono adesso, e che il programma incontrerà al primo giro.
//
// LA REGOLA CHE GOVERNA TUTTO IL FILE, e che vale la pena leggere prima del
// codice: il confronto approssimato NON decide mai una classe. Decide solo
// l'uguaglianza — esatta, oppure dopo aver tolto le differenze di SCRITTURA
// (maiuscole, accenti, apostrofi, spazi, ordine di nome e cognome). Un refuso
// vero come `DIECO` per `DIEGO` non è una differenza di scrittura: è un errore,
// e un errore va corretto da un essere umano, non indovinato da un algoritmo.
// Mettere un bambino nella classe sbagliata è un danno silenzioso — nessuno se
// ne accorge finché non lo cerca la maestra.
//
// La similitudine serve a UNA COSA SOLA: comporre i tre nomi più somiglianti da
// scrivere nella nota, così la segreteria capisce in un colpo d'occhio se è solo
// un refuso. Non entra mai nella decisione.
// ─────────────────────────────────────────────────────────────────────────────

/** Un elenco ridotto ma fedele: sono righe vere del file di Giugliano. */
const ELENCO: RigaElenco[] = [
  { id: 'r1', classe: 'MICRONIDO', nome: 'GRAZIOSO DIECO', riga: 18, retta: 450, rettaTesto: null },
  { id: 'r2', classe: 'MICRONIDO', nome: 'DESIO GIUNTO THIAGO', riga: 9, retta: 330, rettaTesto: null },
  { id: 'r3', classe: 'MICRONIDO', nome: 'SHEMBER ISABEL ', riga: 32, retta: 330, rettaTesto: null },
  { id: 'r4', classe: '2 ANNI A', nome: 'NIOLA NICOLE', riga: 16, retta: 300, rettaTesto: null },
  { id: 'r5', classe: '2 ANNI A', nome: "D'ALTERIO MARIAROSARIA", riga: 6, retta: 300, rettaTesto: null },
  { id: 'r6', classe: '2 ANNI B', nome: 'PALMA ANDREA', riga: 15, retta: 300, rettaTesto: null },
  { id: 'r7', classe: '2 ANNI C', nome: 'PALMA ANDREA', riga: 15, retta: 300, rettaTesto: null },
  { id: 'r8', classe: '2 ANNI C', nome: 'CAPUANO GIULIA RITA', riga: 5, retta: 300, rettaTesto: null },
  { id: 'r9', classe: '2 ANNI C', nome: 'De rosa Christian', riga: 21, retta: 330, rettaTesto: null },
  { id: 'r10', classe: '3 ANNI A', nome: ' ESPOSITO ANDREA (CIRO)', riga: 2, retta: 300, rettaTesto: null },
  { id: 'r11', classe: '4 anni  a', nome: "D'AUSILIO SALVATORE", riga: 9, retta: null, rettaTesto: 'vedi sor' },
  { id: 'r12', classe: '5 anni a', nome: 'CHARMANT NJAMBE', riga: 5, retta: 180, rettaTesto: null },
  { id: 'r13', classe: '5 anni b', nome: "D'AUSILIO SALVATORE", riga: 10, retta: 180, rettaTesto: null },
  { id: 'r14', classe: '5 anni b', nome: 'GIANNINI ALYSSA', riga: 12, retta: 180, rettaTesto: null },
  { id: 'r15', classe: 'II', nome: 'PRIMO ARES VINCENZO', riga: 17, retta: 150, rettaTesto: null },
  { id: 'r16', classe: '2 ANNI A', nome: 'MARCHESE LUDOVICA', riga: 30, retta: null, rettaTesto: null },
  { id: 'r17', classe: 'MICRONIDO', nome: 'MIRAGLIA  ANIELLO ', riga: 25, retta: 330, rettaTesto: null },
]

describe('normalizzaNome — toglie le differenze di scrittura, non gli errori', () => {
  it('ignora maiuscole e minuscole', () => {
    expect(normalizzaNome('De rosa Christian')).toBe('DE ROSA CHRISTIAN')
  })

  it('toglie gli accenti', () => {
    expect(normalizzaNome('MUROLO CÉLINE')).toBe('MUROLO CELINE')
  })

  it('tratta l\'apostrofo come uno spazio: D\'Angelo e D Angelo sono lo stesso', () => {
    expect(normalizzaNome("D'ALTERIO MARIAROSARIA")).toBe('D ALTERIO MARIAROSARIA')
    expect(normalizzaNome('D’AUSILIO SALVATORE')).toBe('D AUSILIO SALVATORE')
  })

  it('stringe gli spazi doppi e toglie quelli ai bordi', () => {
    expect(normalizzaNome('MIRAGLIA  ANIELLO ')).toBe('MIRAGLIA ANIELLO')
    expect(normalizzaNome(' ESPOSITO ANDREA')).toBe('ESPOSITO ANDREA')
  })

  it('butta via le annotazioni fra parentesi: sono note della segreteria, non nomi', () => {
    expect(normalizzaNome(' ESPOSITO ANDREA (CIRO)')).toBe('ESPOSITO ANDREA')
    expect(normalizzaNome('RUSSO GIOVANNI VINCENZO(NIDO)')).toBe('RUSSO GIOVANNI VINCENZO')
  })

  it('regge il vuoto e il nullo senza esplodere', () => {
    expect(normalizzaNome(null)).toBe('')
    expect(normalizzaNome(undefined)).toBe('')
    expect(normalizzaNome('   ')).toBe('')
  })
})

describe('abbina — quando è certo procede, quando non lo è si ferma', () => {
  it('uguaglianza esatta dopo normalizzazione → UNICO', () => {
    const e = abbina('Christian', 'De Rosa', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('2 ANNI C')
  })

  it('nome e cognome invertiti → UNICO (Njambe Charmant sta nel file come Charmant Njambe)', () => {
    const e = abbina('Charmant', 'Njambe', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('5 anni a')
  })

  it('spazio in più o in meno dentro il nome → UNICO (GiuliaRita / GIULIA RITA)', () => {
    const e = abbina('GiuliaRita', 'Capuano', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('2 ANNI C')
  })

  it('cognome staccato in un modo o nell\'altro → UNICO (De Sio Giunto / DESIO GIUNTO)', () => {
    const e = abbina('Thiago', 'De Sio Giunto', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('MICRONIDO')
  })

  it('due bambini con lo stesso nome in due sezioni → AMBIGUO, e non si sceglie', () => {
    const e = abbina('Andrea', 'Palma', ELENCO)
    expect(e.tipo).toBe('ambiguo')
    if (e.tipo === 'ambiguo') {
      expect(e.righe).toHaveLength(2)
      expect(e.righe.map((r) => r.classe).sort()).toEqual(['2 ANNI B', '2 ANNI C'])
    }
  })

  it('lo stesso alunno scritto in due fogli → AMBIGUO (D\'Ausilio Salvatore)', () => {
    const e = abbina('Salvatore', "D'Ausilio", ELENCO)
    expect(e.tipo).toBe('ambiguo')
    if (e.tipo === 'ambiguo') expect(e.righe).toHaveLength(2)
  })

  // ── Il cuore della regola: i refusi NON si indovinano ──────────────────────
  it.each([
    ['Diego', 'Grazioso', 'GRAZIOSO DIECO'],
    ['Nicole', 'Nola', 'NIOLA NICOLE'],
    ['Isabel', 'Schember', 'SHEMBER ISABEL'],
    ['Alyssa', 'Gianini', 'GIANNINI ALYSSA'],
    ['VincenzoAres', 'Primo', 'PRIMO ARES VINCENZO'],
    ['Ludovica Maria', 'Marchese', 'MARCHESE LUDOVICA'],
  ])('«%s %s» somiglia a «%s» ma NON è uguale → ASSENTE, mai indovinato', (nome, cognome, atteso) => {
    const e = abbina(nome, cognome, ELENCO)
    expect(e.tipo).toBe('assente')
    if (e.tipo === 'assente') {
      // il più somigliante entra nella nota, così la segreteria vede il refuso
      expect(normalizzaNome(e.simili[0].nome)).toBe(normalizzaNome(atteso))
      expect(e.simili.length).toBeLessThanOrEqual(3)
    }
  })

  it('chi non somiglia a nessuno resta ASSENTE, con al più tre nomi nella nota', () => {
    const e = abbina('Francesca', 'Porcelli', ELENCO)
    expect(e.tipo).toBe('assente')
    if (e.tipo === 'assente') expect(e.simili.length).toBeLessThanOrEqual(3)
  })

  it('un elenco vuoto non produce mai un abbinamento', () => {
    const e = abbina('Andrea', 'Palma', [])
    expect(e.tipo).toBe('assente')
    if (e.tipo === 'assente') expect(e.simili).toEqual([])
  })
})

describe('gli attrezzi, provati da soli', () => {
  it('senzaSpazi salda i pezzi del nome', () => {
    expect(senzaSpazi('DE SIO GIUNTO THIAGO')).toBe('DESIOGIUNTOTHIAGO')
    expect(senzaSpazi('DESIO GIUNTO THIAGO')).toBe('DESIOGIUNTOTHIAGO')
  })

  it('tokenNome dà le parole, per riconoscere l\'inversione', () => {
    expect([...tokenNome('CHARMANT NJAMBE')].sort()).toEqual(['CHARMANT', 'NJAMBE'])
  })

  it('similitudine: 1 per identici, alta per un refuso, bassa per estranei', () => {
    expect(similitudine('GRAZIOSO DIEGO', 'GRAZIOSO DIEGO')).toBe(1)
    expect(similitudine('GRAZIOSO DIEGO', 'GRAZIOSO DIECO')).toBeGreaterThan(0.8)
    expect(similitudine('GRAZIOSO DIEGO', 'PORCELLI FRANCESCA')).toBeLessThan(0.3)
  })

  it('similitudine non esplode sulle stringhe cortissime', () => {
    expect(similitudine('', '')).toBe(1)
    expect(similitudine('A', '')).toBe(0)
    expect(similitudine('A', 'A')).toBe(1)
  })
})
