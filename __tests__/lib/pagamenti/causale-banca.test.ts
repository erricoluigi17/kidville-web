// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { LIMITE_CAUSALE_BANCA, causalePerBanca, testoPerBanca } from '@/lib/pagamenti/causale-banca'
import { codiceVoce, estraiCodiciVoce } from '@/lib/pagamenti/codice-voce'
import { estraiCodiciFiscali } from '@/lib/pagamenti/riconciliazione'

// ─────────────────────────────────────────────────────────────────────────────
// LA CAUSALE COME LA VUOLE LA BANCA PIÙ SEVERA.
//
// Il set di caratteri che passa DOVUNQUE è l'intersezione fra lo schema SEPA (EPC: lettere,
// cifre, spazio e `/ - ? : ( ) . , ' +`), BancoPosta (che di quel set rifiuta anche
// `/ : ? '`) e Fineco (che elenca solo `/ ? '` oltre ad alfanumerici): lettere, cifre e spazi.
// Il guasto che ha aperto il lavoro (2026-10-09) è il `#` del codice della voce, rifiutato da
// Poste; le misure su produzione dicono che anche `/` (1.434 voci «Retta MM/AAAA»), `—`, gli
// apostrofi dei cognomi e le lettere accentate arrivavano al genitore.
//
// ⚠️ Codici fiscali e uuid qui dentro sono SINTETICI: il repository è pubblico.
// ─────────────────────────────────────────────────────────────────────────────

/** Il set sicuro, scritto UNA volta: ogni uscita deve starci dentro per intero. */
const SET_SICURO = /^[A-Za-z0-9 ]*$/

/** CF sintetico (codice catastale Z999 non assegnato, controllo volutamente sbagliato). */
const CF = 'RSSMRA85T10Z999X'

/** Un codice vero del motore, da un uuid sintetico. */
const CODICE = codiceVoce('00000000-0000-4000-8000-000000000001')

describe('causalePerBanca — il set sicuro', () => {
  const casi: [string, string, string][] = [
    ['il cancelletto del codice voce (il guasto di Poste)', `Retta 10 2026 ${CODICE}`, `Retta 10 2026 ${CODICE.slice(1)}`],
    ['la barra di «Retta MM/AAAA»', 'Retta 10/2026', 'Retta 10 2026'],
    ['l’asterisco', 'Retta*ottobre', 'Retta ottobre'],
    ['l’apostrofo dritto di un cognome', "Mario D'Angelo", 'Mario D Angelo'],
    ['l’apostrofo tipografico', 'Mario D’Angelo', 'Mario D Angelo'],
    ['il trattino di un cognome composto', 'Rossi-Bianchi', 'Rossi Bianchi'],
    ['il separatore « - » del modello storico', 'Retta - per il minore Mario', 'Retta per il minore Mario'],
    ['la lineetta delle rate e dei ticket', 'Ricarica mensa — 20 ticket', 'Ricarica mensa 20 ticket'],
    ['le lettere accentate', 'Niccolò Né Ù À È', 'Niccolo Ne U A E'],
    ['il segno di moltiplicazione del merchandise', 'Merchandise: 2× Felpa (M)', 'Merchandise 2 x Felpa M'],
    ['le lettere che nessuna normalizzazione scompone', 'Weiß Łukasz Ærø Đorđe Œuvre', 'Weiss Lukasz AEro Dorde OEuvre'],
    ['legature e cifre «larghe» (NFKD)', 'ﬁore ２０２６', 'fiore 2026'],
    ['il simbolo dell’euro', '€ 150,00', 'EUR 150 00'],
    ['le parentesi quadre', '[Promemoria] Retta', 'Promemoria Retta'],
    ['tab, a capo e spazi doppi', 'Retta\t10\n\n2026   GIUGLIANO', 'Retta 10 2026 GIUGLIANO'],
    ['un’emoji', 'Retta 🎒 ottobre', 'Retta ottobre'],
    ['simboli in testa e in coda', '#*- Retta -*#', 'Retta'],
  ]

  for (const [nome, ingresso, atteso] of casi) {
    it(`toglie ${nome}`, () => {
      const uscita = causalePerBanca(ingresso)
      expect(uscita).toBe(atteso)
      expect(uscita).toMatch(SET_SICURO)
    })
  }

  it('non tocca una causale che è già sicura', () => {
    const pulita = `Retta 10 2026 ${CODICE.slice(1)} ${CF} Mario Rossi GIUGLIANO`
    expect(causalePerBanca(pulita)).toBe(pulita)
  })

  it('è idempotente: ripulire due volte dà la stessa stringa', () => {
    for (const [, ingresso] of casi) {
      const una = causalePerBanca(ingresso)
      expect(causalePerBanca(una)).toBe(una)
    }
  })

  it('ogni carattere ASCII stampabile e ogni Latin-1 finisce dentro il set sicuro', () => {
    // Prova a tappeto: nessun carattere di questi due blocchi deve uscire tale e quale
    // se non è una lettera o una cifra semplice.
    let tutti = ''
    for (let c = 0x20; c <= 0x7e; c++) tutti += String.fromCharCode(c)
    for (let c = 0xa0; c <= 0xff; c++) tutti += String.fromCharCode(c)
    expect(causalePerBanca(tutti)).toMatch(SET_SICURO)
  })
})

describe('causalePerBanca — il segno «×» non fabbrica un codice', () => {
  it('«245×367» resta due numeri: incollati sarebbero un codice voce finto', () => {
    // `245X367` è fatto di simboli dell'alfabeto del codice, con cifre e lettere: un `x`
    // incollato lo farebbe estrarre, e l'abbinamento automatico lo tratterebbe da codice
    // sconosciuto (giallo) anche su un movimento col codice vero e il CF.
    const uscita = causalePerBanca('Tela 245×367')
    expect(uscita).toBe('Tela 245 x 367')
    expect(estraiCodiciVoce(uscita)).toEqual([])
    // Controllo negativo: la forma incollata il codice lo fabbricherebbe davvero.
    expect(estraiCodiciVoce('Tela 245x367')).toEqual(['#245X367'])
  })
})

describe('testoPerBanca — la stessa pulizia, senza taglio', () => {
  it('non taglia: serve a confrontare, non a stampare', () => {
    const lunga = 'parola '.repeat(40).trim()
    expect(testoPerBanca(lunga)).toBe(lunga)
    expect(testoPerBanca(lunga).length).toBeGreaterThan(LIMITE_CAUSALE_BANCA)
  })

  it('causalePerBanca è testoPerBanca più il taglio, e nient’altro', () => {
    const testo = "Retta 10/2026 — Rata 2/10 per Niccolò D'Angelo"
    expect(causalePerBanca(testo)).toBe(testoPerBanca(testo))
  })
})

describe('causalePerBanca — la lunghezza', () => {
  it('il limite si può stringere: si taglia sull’ultimo spazio entro quel limite', () => {
    expect(causalePerBanca('Retta 10/2026 — Rata 2/10 extra', 24)).toBe('Retta 10 2026 Rata 2 10')
  })

  it('taglia a 140 caratteri sull’ultimo spazio, senza spezzare una parola', () => {
    const lunga = Array.from({ length: 60 }, (_, i) => `parola${i}`).join(' ')
    const uscita = causalePerBanca(lunga)
    expect(LIMITE_CAUSALE_BANCA).toBe(140)
    expect(uscita.length).toBeLessThanOrEqual(LIMITE_CAUSALE_BANCA)
    expect(lunga.startsWith(uscita)).toBe(true)
    expect(uscita.endsWith(' ')).toBe(false)
    // L'ultima parola tenuta è intera: subito dopo, nel testo di partenza, c'è uno spazio.
    expect(lunga[uscita.length]).toBe(' ')
  })

  it('una parola sola più lunga del limite si taglia al limite (non si butta tutto)', () => {
    const uscita = causalePerBanca('X'.repeat(300))
    expect(uscita).toBe('X'.repeat(LIMITE_CAUSALE_BANCA))
  })

  it('il taglio arriva DOPO la pulizia: conta i caratteri che la banca vede davvero', () => {
    // 140 «é» diventano 140 «e»: nessun taglio da fare, anche se in NFD erano 280 unità.
    expect(causalePerBanca('é'.repeat(140))).toBe('e'.repeat(140))
  })
})

describe('causalePerBanca — l’abbinamento continua a funzionare', () => {
  it('codice voce e codice fiscale escono intatti e si estraggono dalla stringa ripulita', () => {
    const uscita = causalePerBanca(`Retta 10/2026 ${CODICE} - per il minore Mario D'Angelo - ${CF} - GIUGLIANO`)
    expect(estraiCodiciVoce(uscita)).toEqual([CODICE])
    expect(estraiCodiciFiscali(uscita)).toEqual([CF])
  })
})

describe('causalePerBanca — difese', () => {
  it('un valore che non è una stringa dà la stringa vuota, non un 500', () => {
    expect(causalePerBanca(null as unknown as string)).toBe('')
    expect(causalePerBanca(undefined as unknown as string)).toBe('')
    expect(causalePerBanca(42 as unknown as string)).toBe('')
  })

  it('una stringa di soli simboli dà la stringa vuota', () => {
    expect(causalePerBanca(' #*/-—’ ')).toBe('')
  })
})
