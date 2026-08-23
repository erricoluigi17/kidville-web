import { describe, it, expect } from 'vitest'
import { passwordTemporanea, classificaFormaPassword } from '@/lib/auth/password-temporanea'
import { esc } from '@/lib/email/html'

/**
 * PERCHÉ QUESTO FILE ESISTE — la misura del 2026-08-22.
 *
 * Il cron delle iscrizioni ha spedito 67 password temporanee del vecchio formato
 * (`randomBytes(18).toString('base64url') + 'Aa1!'`): 28 caratteri con `-`, `_`,
 * maiuscole e minuscole mischiate e le coppie indistinguibili `l`/`I`/`1` e `O`/`0`.
 * 37 famiglie sono entrate, 30 no, e alcune hanno telefonato in segreteria.
 *
 * Una password temporanea non è un segreto che si custodisce: è un segreto che si
 * ATTRAVERSA, una volta sola, spesso leggendola su un telefono e digitandola su un
 * altro schermo, a volte dettandola al telefono a un nonno. Ogni proprietà qui sotto
 * difende quel passaggio — e la n. 4 (niente spazi) è quella che il vecchio formato
 * non poteva garantire a chi selezionava col dito.
 */

const CAMPIONI = 5000

describe('passwordTemporanea', () => {
  const campioni = Array.from({ length: CAMPIONI }, () => passwordTemporanea())

  it('ha la forma Xxxx-xxxx-xxxx-xxxx: quattro gruppi da quattro', () => {
    const forma = /^[ACDEFHJKMNPRTVWXY][0-9a-hjkmnp-tv-z]{3}(-[0-9a-hjkmnp-tv-z]{4}){3}$/
    for (const p of campioni) expect(p).toMatch(forma)
  })

  it('non contiene MAI un carattere ambiguo: i, l, o, u, I, L, O, U, B, G, S, Z, Q', () => {
    // Crockford esclude i/l/o/u (confondibili con 1 e 0, e per non comporre parole).
    // Alle maiuscole togliamo anche B/8, G/6, S/5, Z/2, Q/O: chi detta al telefono
    // non deve mai dover dire «la esse, non il cinque».
    for (const p of campioni) expect(p).not.toMatch(/[ilouILOUBGSZQ]/)
  })

  it('contiene sempre almeno una cifra e almeno una lettera', () => {
    // È la conformità alla policy `letters_digits` di GoTrue, ottenuta per
    // costruzione e non appiccicando un suffisso noto come faceva `Aa1!`.
    for (const p of campioni) {
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/[a-z]/)
    }
  })

  it('soddisfa la policy più severa di GoTrue: minuscola, MAIUSCOLA, cifra, simbolo', () => {
    // Il trattino è nel set dei simboli di GoTrue. Con questa proprietà il formato
    // è valido qualunque sia la policy configurata sul progetto: non serve leggerla
    // per sapere che passerà, e non si romperà il giorno che qualcuno la irrigidisce.
    for (const p of campioni) {
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).toMatch(/-/)
    }
  })

  it('NON contiene spazi, in nessuna posizione', () => {
    // La proprietà che chiude alla radice il difetto del 22/08: una password senza
    // spazi non può essere «copiata con uno spazio in mezzo». Ai bordi ci pensa il
    // login, ma dentro non ci deve arrivare niente da trimmare.
    for (const p of campioni) {
      expect(p).not.toMatch(/\s/)
      expect(p).toBe(p.trim())
    }
  })

  it('attraversa l\'email senza essere trasformata: esc(p) === p', () => {
    // Se un solo carattere diventasse un'entità HTML, la password mostrata alla
    // famiglia non sarebbe più quella scritta su GoTrue. È l'invariante di
    // byte-identità fra ciò che si salva e ciò che si spedisce.
    for (const p of campioni) expect(esc(p)).toBe(p)
  })

  it('non si ripete: 5000 campioni, 5000 valori distinti', () => {
    expect(new Set(campioni).size).toBe(CAMPIONI)
  })

  it('è lunga 19 caratteri', () => {
    for (const p of campioni) expect(p).toHaveLength(19)
  })

  it('usa tutto l\'alfabeto: nessun carattere resta mai fuori', () => {
    // Guardia contro un bias di campionamento introdotto in futuro (per esempio un
    // `% 32` al posto di randomInt): se un carattere sparisse dall'uscita, l'entropia
    // dichiarata nel PRD sarebbe una bugia e nessun altro test se ne accorgerebbe.
    const visti = new Set(campioni.join('').replace(/-/g, ''))
    const attesi = '0123456789abcdefghjkmnpqrstvwxyz'.split('')
    for (const c of attesi) expect(visti.has(c)).toBe(true)
  })
})

describe('classificaFormaPassword', () => {
  // Serve al log dei fallimenti d'accesso: dice se chi ha sbagliato stava
  // incollando una password temporanea (l'invito non funziona) o una scelta da sé
  // (l'ha dimenticata). Sono due guasti diversi e vanno separati nei log.
  it('riconosce il formato nuovo', () => {
    expect(classificaFormaPassword(passwordTemporanea())).toBe('temporanea')
  })

  it('riconosce il formato vecchio, quello spedito il 22/08', () => {
    expect(classificaFormaPassword('abcdefghijklmnopqrstuvwxAa1!')).toBe('temporanea-legacy')
  })

  it('chiama «altra» qualunque password scelta da una persona', () => {
    expect(classificaFormaPassword('ciaomamma2026')).toBe('altra')
    expect(classificaFormaPassword('')).toBe('altra')
  })

  it('classifica la forma anche con spazi ai bordi', () => {
    // Chi incolla male deve comunque essere riconosciuto come «stava usando
    // l'invito»: altrimenti il log perderebbe proprio i casi che deve spiegare.
    expect(classificaFormaPassword(`  ${passwordTemporanea()}  `)).toBe('temporanea')
  })
})
