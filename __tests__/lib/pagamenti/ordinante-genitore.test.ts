import { describe, it, expect } from 'vitest'
import { riconosciOrdinante, type CandidatoGenitore } from '@/lib/pagamenti/ordinante-genitore'
import { similitudine } from '@/lib/iscrizioni/import/normalizza'

// =============================================================================
// CHI HA FATTO IL BONIFICO — e quando è meglio non saperlo.
//
// Tutti i nomi qui sotto sono INVENTATI. Non uno viene da un estratto conto
// vero: il repository è pubblico, e un ordinante di bonifico è un dato
// personale di una famiglia che paga la retta di un bambino.
//
// La cosa che questi test difendono davvero è il NEGATIVO: che un nome che
// somiglia al 92% non venga mai proposto. Un falso positivo qui non è un
// bambino nella classe sbagliata — è una fattura elettronica intestata a un
// estraneo, col suo codice fiscale, già trasmessa all'Agenzia delle Entrate.
// =============================================================================

const c = (adultId: string, nome: string): CandidatoGenitore => ({ adultId, nome })

// I due genitori di un bambino qualunque: è sempre questo l'insieme di ricerca.
const MADRE = c('adulto-madre', 'Verdi Anna')
const PADRE = c('adulto-padre', 'Rossi Mario')

describe('riconosciOrdinante — fase 1, uguaglianza', () => {
  it('1. nome identico: proposta unica, motivo bonifico_esatto', () => {
    const esito = riconosciOrdinante('ROSSI MARIO', [PADRE, MADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-padre', motivo: 'bonifico_esatto' })
  })

  it('1-bis. la scrittura identica batte le stesse parole in ordine diverso', () => {
    // `perEsatto` è sempre un sottoinsieme di `perToken`: se la prima forma non
    // si fermasse qui, un doppione con nome e cognome invertiti renderebbe
    // «ambiguo» un ordinante scritto lettera per lettera come l'anagrafica.
    // `invertito` sta per primo nell'elenco apposta: chi prendesse «il primo»
    // sbaglierebbe.
    const invertito = c('adulto-invertito', 'Mario Rossi')
    const identico = c('adulto-identico', 'Rossi Mario')
    const esito = riconosciOrdinante('ROSSI MARIO', [invertito, identico])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-identico', motivo: 'bonifico_esatto' })
  })

  it('2. le stesse parole in ordine invertito sono la stessa persona', () => {
    const esito = riconosciOrdinante('MARIO ROSSI', [PADRE, MADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-padre', motivo: 'bonifico_esatto' })
  })

  it('3. lo stesso nome con gli spazi in un altro punto (DELUCA / DE LUCA)', () => {
    const genitore = c('adulto-1', 'De Luca Giulia')
    const esito = riconosciOrdinante('DELUCA GIULIA', [genitore])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-1', motivo: 'bonifico_esatto' })
  })

  it('4. maiuscolo e minuscolo mescolati non sono una differenza', () => {
    const esito = riconosciOrdinante('Anna Verdi', [PADRE, MADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-madre', motivo: 'bonifico_esatto' })
  })

  it('5. accenti scritti in un modo dalla banca e in un altro in anagrafica', () => {
    const genitore = c('adulto-1', 'Nicolò Russo')
    const esito = riconosciOrdinante('NICOLO RUSSO', [genitore])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-1', motivo: 'bonifico_esatto' })
  })

  it('6. due candidati corrispondono esattamente (doppione in anagrafica): AMBIGUO, nessuna proposta', () => {
    const doppione = c('adulto-doppione', 'ROSSI  MARIO')
    const esito = riconosciOrdinante('ROSSI MARIO', [PADRE, doppione, MADRE])
    expect(esito).toEqual({ tipo: 'ambiguo', candidati: [PADRE, doppione] })
  })
})

describe('riconosciOrdinante — la somiglianza non decide MAI', () => {
  it('7. un refuso di una lettera non produce nessuna proposta, e il nome resta fra i «forse cercavi»', () => {
    const esito = riconosciOrdinante('ROSSI MRAIO', [PADRE, MADRE])
    expect(esito.tipo).toBe('assente')
    if (esito.tipo !== 'assente') throw new Error('atteso assente')
    expect(esito.simili).toContainEqual(PADRE)
  })

  it('16. ⛔ un candidato al 92% di somiglianza e nessuno uguale: ASSENTE', () => {
    const quasi = c('adulto-1', 'Bianchi Carlo')
    // La somiglianza c'è, ed è altissima: è proprio questo il punto del test.
    expect(similitudine('BIANCHI CARLA', quasi.nome)).toBeGreaterThan(0.9)

    const esito = riconosciOrdinante('BIANCHI CARLA', [quasi])
    expect(esito).toEqual({ tipo: 'assente', simili: [quasi] })
  })
})

describe('riconosciOrdinante — fase 2, sottoinsieme', () => {
  // Il caso tipico: la banca scrive i due intestatari del conto uno dopo l'altro.
  const COINTESTATO = 'ROSSI MARIO  VERDI ANNA'

  it('11. un solo candidato dentro il nome dell\'ordinante: proposta, motivo sottoinsieme_unico', () => {
    // L'altro nome sul conto è una persona che non abbiamo in anagrafica.
    const esito = riconosciOrdinante('ROSSI MARIO  BIANCHI CARLA', [PADRE, MADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-padre', motivo: 'sottoinsieme_unico' })
  })

  it('11-bis. il sottoinsieme non prova che il conto sia cointestato: può essere un nome composto registrato a metà', () => {
    // In anagrafica c'è `Verdi Anna`, la banca scrive il nome per intero. Non
    // c'è nessun secondo intestatario: è la stessa persona scritta più corta.
    // Ecco perché il motivo si chiama per il MECCANISMO (sottoinsieme) e non
    // per un'ipotesi sul conto che qui sarebbe falsa.
    const esito = riconosciOrdinante('VERDI ANNA MARIA', [MADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-madre', motivo: 'sottoinsieme_unico' })
  })

  it('8. due candidati dentro i due nomi, uno marcato sulla scheda del bambino: vince quello, motivo sottoinsieme_scheda', () => {
    const esito = riconosciOrdinante(COINTESTATO, [PADRE, MADRE], { intestatarioScheda: 'adulto-madre' })
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-madre', motivo: 'sottoinsieme_scheda' })
  })

  it('9. due candidati e nessuno marcato: AMBIGUO — mai «il primo»', () => {
    const esito = riconosciOrdinante(COINTESTATO, [PADRE, MADRE])
    expect(esito).toEqual({ tipo: 'ambiguo', candidati: [PADRE, MADRE] })
  })

  it('10. nessuno sulla scheda ma uno è intestatario di famiglia: vince quello, motivo sottoinsieme_famiglia', () => {
    const esito = riconosciOrdinante(COINTESTATO, [PADRE, MADRE], { intestatarioFamiglia: 'adulto-padre' })
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-padre', motivo: 'sottoinsieme_famiglia' })
  })

  it('10-bis. la scheda del bambino batte l\'intestatario di famiglia, come nella cascata delle quote', () => {
    const esito = riconosciOrdinante(COINTESTATO, [PADRE, MADRE], {
      intestatarioScheda: 'adulto-madre',
      intestatarioFamiglia: 'adulto-padre',
    })
    // Il motivo dice QUALE delle due fonti ha deciso: `sottoinsieme_famiglia`
    // qui sarebbe una spiegazione sbagliata di una proposta giusta.
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-madre', motivo: 'sottoinsieme_scheda' })
  })

  it('10-ter. un intestatario che non è fra i candidati non sceglie per loro: resta AMBIGUO', () => {
    const esito = riconosciOrdinante(COINTESTATO, [PADRE, MADRE], { intestatarioScheda: 'adulto-estraneo' })
    expect(esito).toEqual({ tipo: 'ambiguo', candidati: [PADRE, MADRE] })
  })

  it('12. un candidato di un solo token non fa mai sottoinsieme', () => {
    const soloNome = c('adulto-solo-nome', 'Mario')
    const esito = riconosciOrdinante(COINTESTATO, [soloNome])
    expect(esito).toEqual({ tipo: 'assente', simili: [soloNome] })
  })

  it('12-bis. e non rende ambigua la proposta buona che gli sta accanto', () => {
    const soloNome = c('adulto-solo-nome', 'Mario')
    const esito = riconosciOrdinante('ROSSI MARIO  BIANCHI CARLA', [soloNome, PADRE])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-padre', motivo: 'sottoinsieme_unico' })
  })
})

describe('riconosciOrdinante — l\'ordine delle due fasi', () => {
  it('15. la fase 1 precede la fase 2: chi corrisponde esattamente vince su chi è sottoinsieme', () => {
    const esatto = c('adulto-esatto', 'Verdi Anna Maria')
    const sottoinsieme = c('adulto-sottoinsieme', 'Anna Maria')
    // Attenzione: `esatto` è ANCHE sottoinsieme di sé stesso. Se le due fasi
    // fossero invertite, o fuse, l'esito sarebbe «ambiguo» fra i due.
    const esito = riconosciOrdinante('VERDI ANNA MARIA', [esatto, sottoinsieme])
    expect(esito).toEqual({ tipo: 'unico', adultId: 'adulto-esatto', motivo: 'bonifico_esatto' })
  })
})

describe('riconosciOrdinante — i casi degeneri non lanciano', () => {
  it('13. ordinante vuoto, di soli spazi, null o undefined: assente', () => {
    for (const vuoto of ['', '   ', null, undefined]) {
      const esito = riconosciOrdinante(vuoto, [PADRE, MADRE])
      expect(esito.tipo).toBe('assente')
    }
  })

  it('13-bis. un ordinante di soli simboli (la banca scrive di tutto) non abbina nessuno', () => {
    const esito = riconosciOrdinante('***/// -- ***', [PADRE, MADRE])
    expect(esito.tipo).toBe('assente')
  })

  it('14. elenco dei candidati vuoto: assente, senza «forse cercavi»', () => {
    expect(riconosciOrdinante('ROSSI MARIO', [])).toEqual({ tipo: 'assente', simili: [] })
  })

  it('14-bis. un candidato senza nome non abbina l\'ordinante vuoto', () => {
    const senzaNome = c('adulto-senza-nome', '')
    const esito = riconosciOrdinante('', [senzaNome])
    expect(esito.tipo).toBe('assente')
  })
})
