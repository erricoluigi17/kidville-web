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
// I nomi qui sotto sono INVENTATI: i bambini veri non entrano nel repository,
// che è pubblico. Ma la FORMA è quella misurata il 2026-08-16 sul file vero di
// Giugliano (338 righe) e sulle 221 domande di quella sede già arrivate in
// `enrollment_submissions`. Ogni difformità riprodotta qui — l'apostrofo dritto
// e quello curvo, gli spazi doppi e quelli in coda, l'annotazione fra parentesi,
// il nome scritto in minuscolo, il cognome saldato, l'ordine invertito, lo
// stesso bambino su due fogli — è una difformità che esiste adesso, e che il
// programma incontrerà alla prima passata. Cambiano i nomi, non i casi.
//
// LA REGOLA CHE GOVERNA TUTTO IL FILE, e che vale la pena leggere prima del
// codice: il confronto approssimato NON decide mai una classe. Decide solo
// l'uguaglianza — esatta, oppure dopo aver tolto le differenze di SCRITTURA
// (maiuscole, accenti, apostrofi, spazi, ordine di nome e cognome). Un refuso
// vero come `EMNA` per `EMMA` non è una differenza di scrittura: è un errore,
// e un errore va corretto da un essere umano, non indovinato da un algoritmo.
// Mettere un bambino nella classe sbagliata è un danno silenzioso — nessuno se
// ne accorge finché non lo cerca la maestra.
//
// La similitudine serve a UNA COSA SOLA: comporre i tre nomi più somiglianti da
// scrivere nella nota, così la segreteria capisce in un colpo d'occhio se è solo
// un refuso. Non entra mai nella decisione.
// ─────────────────────────────────────────────────────────────────────────────

/** Un elenco ridotto: i nomi sono inventati, le difformità di scrittura no. */
const ELENCO: RigaElenco[] = [
  { id: 'r1', classe: 'MICRONIDO', nome: 'SALICETTI EMNA', riga: 18, retta: 450, rettaTesto: null },
  { id: 'r2', classe: 'MICRONIDO', nome: 'DELPRATO ORZATELLI SAMUELE', riga: 9, retta: 330, rettaTesto: null },
  { id: 'r3', classe: 'MICRONIDO', nome: 'SHERMONI ASIA ', riga: 32, retta: 330, rettaTesto: null },
  { id: 'r4', classe: '2 ANNI A', nome: 'PIOVANELLI GRETA', riga: 16, retta: 300, rettaTesto: null },
  { id: 'r5', classe: '2 ANNI A', nome: "D'ALMONTE ANNAGIULIA", riga: 6, retta: 300, rettaTesto: null },
  { id: 'r6', classe: '2 ANNI B', nome: 'FABBRI TOMMASO', riga: 15, retta: 300, rettaTesto: null },
  { id: 'r7', classe: '2 ANNI C', nome: 'FABBRI TOMMASO', riga: 15, retta: 300, rettaTesto: null },
  { id: 'r8', classe: '2 ANNI C', nome: 'BIANCHI ANNA LUCIA', riga: 5, retta: 300, rettaTesto: null },
  { id: 'r9', classe: '2 ANNI C', nome: 'Corbezzi edoardo', riga: 21, retta: 330, rettaTesto: null },
  { id: 'r10', classe: '3 ANNI A', nome: ' GIRASOLI FEDERICO (RICO)', riga: 2, retta: 300, rettaTesto: null },
  { id: 'r11', classe: '4 anni  a', nome: "D'ARGILLA PIETRO", riga: 9, retta: null, rettaTesto: 'vedi sor' },
  { id: 'r12', classe: '5 anni a', nome: 'LEONARDO ZAFFERANI', riga: 5, retta: 180, rettaTesto: null },
  { id: 'r13', classe: '5 anni b', nome: "D'ARGILLA PIETRO", riga: 10, retta: 180, rettaTesto: null },
  { id: 'r14', classe: '5 anni b', nome: 'CAMOMILLI IRENE', riga: 12, retta: 180, rettaTesto: null },
  { id: 'r15', classe: 'II', nome: 'VELLUTINI LUCA MICHELE', riga: 17, retta: 150, rettaTesto: null },
  { id: 'r16', classe: '2 ANNI A', nome: 'NEBBIOLI CHIARA', riga: 30, retta: null, rettaTesto: null },
  { id: 'r17', classe: 'MICRONIDO', nome: 'LUMINELLI  DAVIDE ', riga: 25, retta: 330, rettaTesto: null },
]

describe('normalizzaNome — toglie le differenze di scrittura, non gli errori', () => {
  it('ignora maiuscole e minuscole', () => {
    expect(normalizzaNome('Corbezzi edoardo')).toBe('CORBEZZI EDOARDO')
  })

  it('toglie gli accenti', () => {
    expect(normalizzaNome('PERLINI NOÉMIE')).toBe('PERLINI NOEMIE')
  })

  it('tratta l\'apostrofo come uno spazio: D\'Almonte e D Almonte sono lo stesso', () => {
    expect(normalizzaNome("D'ALMONTE ANNAGIULIA")).toBe('D ALMONTE ANNAGIULIA')
    expect(normalizzaNome('D’ARGILLA PIETRO')).toBe('D ARGILLA PIETRO')
  })

  it('stringe gli spazi doppi e toglie quelli ai bordi', () => {
    expect(normalizzaNome('LUMINELLI  DAVIDE ')).toBe('LUMINELLI DAVIDE')
    expect(normalizzaNome(' GIRASOLI FEDERICO')).toBe('GIRASOLI FEDERICO')
  })

  it('butta via le annotazioni fra parentesi: sono note della segreteria, non nomi', () => {
    expect(normalizzaNome(' GIRASOLI FEDERICO (RICO)')).toBe('GIRASOLI FEDERICO')
    expect(normalizzaNome('PERLINI CARLO ALBERTO(NIDO)')).toBe('PERLINI CARLO ALBERTO')
  })

  it('regge il vuoto e il nullo senza esplodere', () => {
    expect(normalizzaNome(null)).toBe('')
    expect(normalizzaNome(undefined)).toBe('')
    expect(normalizzaNome('   ')).toBe('')
  })
})

describe('abbina — quando è certo procede, quando non lo è si ferma', () => {
  it('uguaglianza esatta dopo normalizzazione → UNICO', () => {
    const e = abbina('Edoardo', 'Corbezzi', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('2 ANNI C')
  })

  it('nome e cognome invertiti → UNICO (Zafferani Leonardo sta nel file come Leonardo Zafferani)', () => {
    const e = abbina('Leonardo', 'Zafferani', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('5 anni a')
  })

  it('spazio in più o in meno dentro il nome → UNICO (AnnaLucia / ANNA LUCIA)', () => {
    const e = abbina('AnnaLucia', 'Bianchi', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('2 ANNI C')
  })

  it('cognome staccato in un modo o nell\'altro → UNICO (Del Prato Orzatelli / DELPRATO ORZATELLI)', () => {
    const e = abbina('Samuele', 'Del Prato Orzatelli', ELENCO)
    expect(e.tipo).toBe('unico')
    if (e.tipo === 'unico') expect(e.riga.classe).toBe('MICRONIDO')
  })

  it('due bambini con lo stesso nome in due sezioni → AMBIGUO, e non si sceglie', () => {
    const e = abbina('Tommaso', 'Fabbri', ELENCO)
    expect(e.tipo).toBe('ambiguo')
    if (e.tipo === 'ambiguo') {
      expect(e.righe).toHaveLength(2)
      expect(e.righe.map((r) => r.classe).sort()).toEqual(['2 ANNI B', '2 ANNI C'])
    }
  })

  it('lo stesso alunno scritto in due fogli → AMBIGUO (D\'Argilla Pietro)', () => {
    const e = abbina('Pietro', "D'Argilla", ELENCO)
    expect(e.tipo).toBe('ambiguo')
    if (e.tipo === 'ambiguo') expect(e.righe).toHaveLength(2)
  })

  // ── Il cuore della regola: i refusi NON si indovinano ──────────────────────
  // Sei forme di «somiglia ma non è uguale», una per riga e tutte viste sul file
  // vero: una lettera sostituita · una vocale in meno · una consonante in meno ·
  // una doppia scempiata · due nomi saldati e invertiti · un secondo nome in più.
  it.each([
    ['Emma', 'Salicetti', 'SALICETTI EMNA'],
    ['Greta', 'Povanelli', 'PIOVANELLI GRETA'],
    ['Asia', 'Schermoni', 'SHERMONI ASIA'],
    ['Irene', 'Camomili', 'CAMOMILLI IRENE'],
    ['MicheleLuca', 'Vellutini', 'VELLUTINI LUCA MICHELE'],
    ['Chiara Sofia', 'Nebbioli', 'NEBBIOLI CHIARA'],
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
    const e = abbina('Viola', 'Quercini', ELENCO)
    expect(e.tipo).toBe('assente')
    if (e.tipo === 'assente') expect(e.simili.length).toBeLessThanOrEqual(3)
  })

  it('un elenco vuoto non produce mai un abbinamento', () => {
    const e = abbina('Tommaso', 'Fabbri', [])
    expect(e.tipo).toBe('assente')
    if (e.tipo === 'assente') expect(e.simili).toEqual([])
  })
})

describe('gli attrezzi, provati da soli', () => {
  it('senzaSpazi salda i pezzi del nome', () => {
    expect(senzaSpazi('DEL PRATO ORZATELLI SAMUELE')).toBe('DELPRATOORZATELLISAMUELE')
    expect(senzaSpazi('DELPRATO ORZATELLI SAMUELE')).toBe('DELPRATOORZATELLISAMUELE')
  })

  it('tokenNome dà le parole, per riconoscere l\'inversione', () => {
    expect([...tokenNome('LEONARDO ZAFFERANI')].sort()).toEqual(['LEONARDO', 'ZAFFERANI'])
  })

  it('similitudine: 1 per identici, alta per un refuso, bassa per estranei', () => {
    expect(similitudine('SALICETTI EMMA', 'SALICETTI EMMA')).toBe(1)
    expect(similitudine('SALICETTI EMMA', 'SALICETTI EMNA')).toBeGreaterThan(0.8)
    expect(similitudine('SALICETTI EMMA', 'QUERCINI VIOLA')).toBeLessThan(0.3)
  })

  it('similitudine non esplode sulle stringhe cortissime', () => {
    expect(similitudine('', '')).toBe(1)
    expect(similitudine('A', '')).toBe(0)
    expect(similitudine('A', 'A')).toBe(1)
  })
})
