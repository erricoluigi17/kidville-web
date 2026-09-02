import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  LUNGHEZZA_MINIMA_PASSWORD,
  valutaPasswordNuova,
  forzaPassword,
  type CodiceRegolaPassword,
} from '@/lib/auth/regole-password'

/**
 * PERCHÉ QUESTO FILE ESISTE — la regola della password stava in due posti, e diceva
 * due cose diverse.
 *
 * `POST /api/parent/onboarding` pretendeva 8 caratteri; `supabase/config.toml` ne
 * dichiarava 6 al provider; la schermata di onboarding ne ripeteva 8 per conto suo.
 * Tre numeri per lo stesso gesto — scegliere la propria password — e nessun test che
 * potesse accorgersi della divergenza, perché ogni copia era coerente con sé stessa.
 *
 * Da qui in avanti la regola è UNA, sta in `src/lib/auth/regole-password.ts`, e questo
 * file è ciò che impedisce alle copie di ricrescere: se qualcuno cambia il minimo, lo
 * cambia in un posto solo e questo test lo vede.
 *
 * NB: le password scritte qui sotto sono INVENTATE e servono a esercitare le regole.
 * Non sono, e non devono mai diventare, credenziali vere di nessuno.
 */

/** Il codice restituito, oppure `'OK'` — comodo per asserire in una riga sola. */
const esito = (nuova: string, attuale?: string): CodiceRegolaPassword | 'OK' => {
  const r = valutaPasswordNuova(nuova, attuale)
  return r.ok ? 'OK' : r.codice
}

describe('valutaPasswordNuova — le quattro regole', () => {
  it('il minimo è 10 caratteri, e il minimo è UNO SOLO', () => {
    expect(LUNGHEZZA_MINIMA_PASSWORD).toBe(10)
  })

  it('la nostra soglia non scende MAI sotto quella del provider (supabase/config.toml)', () => {
    // Il controllo che nessuno farebbe a mano: `minimum_password_length` è la soglia
    // di GoTrue, non una politica nostra. Se un domani il provider la alzasse sopra
    // la nostra, il nostro «ok» sarebbe una bugia — la password verrebbe rifiutata
    // DOPO, dal provider, con un messaggio che il genitore non può interpretare.
    const toml = readFileSync(path.join(process.cwd(), 'supabase/config.toml'), 'utf8')
    const m = toml.match(/^\s*minimum_password_length\s*=\s*(\d+)/m)
    expect(m, 'minimum_password_length sparito da supabase/config.toml').not.toBeNull()
    expect(LUNGHEZZA_MINIMA_PASSWORD).toBeGreaterThanOrEqual(Number(m![1]))
  })

  it('il caso felice passa', () => {
    expect(esito('nonnaRosa42')).toBe('OK')
    expect(esito('parolachiave1')).toBe('OK')
  })

  it('esattamente 10 caratteri passa, 9 no — il limite è dove è scritto', () => {
    const dieci = 'abcdefgh12'
    const nove = 'abcdefg12'
    expect(dieci).toHaveLength(10)
    expect(nove).toHaveLength(9)
    expect(esito(dieci)).toBe('OK')
    expect(esito(nove)).toBe('PASSWORD_TROPPO_CORTA')
  })

  it('la stringa vuota è troppo corta (non «senza cifra», non un’eccezione)', () => {
    expect(esito('')).toBe('PASSWORD_TROPPO_CORTA')
  })

  it('solo lettere: manca la cifra', () => {
    expect(esito('parolachiave')).toBe('PASSWORD_SENZA_CIFRA')
  })

  it('solo cifre: manca la lettera, e lo dice lo stesso codice', () => {
    // La policy `letters_digits` di GoTrue è UNA: «almeno una lettera e almeno una
    // cifra». Due codici distinti per le sue due metà darebbero al client due
    // messaggi da tradurre per la stessa regola.
    expect(esito('1234567890')).toBe('PASSWORD_SENZA_CIFRA')
  })

  it('le accentate NON contano come lettere: l’alfabeto è quello di GoTrue, non il nostro', () => {
    // `letters_digits` di GoTrue conta i caratteri di `a-zA-Z`. Se qui accettassimo
    // `à` come lettera, `àèéàèéàè1à` passerebbe da noi e verrebbe rifiutata DOPO dal
    // provider, con un messaggio che il genitore non può interpretare: esattamente il
    // rifiuto opaco che questa regola esiste per evitare.
    expect(esito('àèéàèéàè1à')).toBe('PASSWORD_SENZA_CIFRA')
  })

  it('uno spazio in TESTA non passa', () => {
    expect(esito(' parolachiave1')).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
  })

  it('uno spazio in CODA non passa', () => {
    expect(esito('parolachiave1 ')).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
  })

  it('uno spazio IN MEZZO è ammesso: è una password legittima, non un errore di incollaggio', () => {
    // Il secondo tentativo d'accesso di `src/app/auth/login/page.tsx` esiste per
    // sopravvivere agli spazi ai BORDI, non per vietare le frasi di passaggio.
    expect(esito('nonna rosa 42')).toBe('OK')
  })

  it('anche una tabulazione o un a capo ai bordi contano come spazio', () => {
    expect(esito('\tparolachiave1')).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
    expect(esito('parolachiave1\n')).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
  })

  it('uguale alla precedente: rifiutata', () => {
    expect(esito('nonnaRosa42', 'nonnaRosa42')).toBe('PASSWORD_UGUALE_ALLA_PRECEDENTE')
  })

  it('diversa dalla precedente: passa', () => {
    expect(esito('nonnaRosa42', 'nonnaRosa43')).toBe('OK')
  })

  it('senza `attuale` l’ultima regola NON si applica (la route di onboarding non la conosce)', () => {
    expect(esito('nonnaRosa42')).toBe('OK')
    expect(esito('nonnaRosa42', undefined)).toBe('OK')
  })

  it('il confronto con la precedente è esatto: maiuscole e spazi contano', () => {
    expect(esito('nonnaRosa42', 'nonnarosa42')).toBe('OK')
    expect(esito('nonna rosa 42', 'nonna rosa 42')).toBe('PASSWORD_UGUALE_ALLA_PRECEDENTE')
  })
})

describe('valutaPasswordNuova — l’ordine di verifica è quello dichiarato', () => {
  it('corta E senza cifra ⇒ corta', () => {
    expect(esito('abc')).toBe('PASSWORD_TROPPO_CORTA')
  })

  it('corta E con spazi ai bordi ⇒ corta', () => {
    expect(esito(' ab1 ')).toBe('PASSWORD_TROPPO_CORTA')
  })

  it('senza cifra E con spazi ai bordi ⇒ senza cifra', () => {
    expect(esito(' parolachiave ')).toBe('PASSWORD_SENZA_CIFRA')
  })

  it('con spazi ai bordi E uguale alla precedente ⇒ spazi ai bordi', () => {
    expect(esito(' parolachiave1 ', ' parolachiave1 ')).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
  })

  it('l’esito positivo non porta nessun codice, quello negativo lo porta sempre', () => {
    const buona = valutaPasswordNuova('nonnaRosa42')
    expect(buona).toEqual({ ok: true })
    const cattiva = valutaPasswordNuova('abc')
    expect(cattiva.ok).toBe(false)
    expect(cattiva.ok === false && cattiva.codice).toBeTruthy()
  })
})

/**
 * IL GENERATORE, deterministico di proposito.
 *
 * La monotonia è una proprietà, non un esempio: si prova su tanti casi o non si prova.
 * Ma un test che pesca davvero a caso, e fallisce una volta al mese su un caso che
 * nessuno può riprodurre, si impara a rilanciare — non a leggere. Con un seme fisso
 * il controesempio è sempre lo stesso e si può stampare.
 */
function generatore(seme: number): () => number {
  let s = seme >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

/** Lettere, cifre, simboli, accentate e lo SPAZIO: l'alfabeto di chi digita davvero. */
const ALFABETO = [...' abcxyzABCXYZ019!@#àèé-_']

describe('forzaPassword', () => {
  it('sta sempre fra 0 e 4, ed è un intero', () => {
    const rnd = generatore(1)
    for (let i = 0; i < 500; i++) {
      const n = Math.floor(rnd() * 30)
      const p = Array.from({ length: n }, () => ALFABETO[Math.floor(rnd() * ALFABETO.length)]).join('')
      const f = forzaPassword(p)
      expect(Number.isInteger(f)).toBe(true)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(4)
    }
  })

  it('DISCRIMINA davvero (controllo positivo: `return 0` passerebbe la monotonia)', () => {
    // Senza questo, una funzione costante soddisfarebbe ogni proprietà qui sotto:
    // «monotona» e «cieca» hanno lo stesso colore.
    expect(forzaPassword('')).toBe(0)
    expect(forzaPassword('Nonna-Rosa-42-x!')).toBe(4)
    const visti = new Set([
      forzaPassword(''),
      forzaPassword('abc'),
      forzaPassword('abcdefghij'),
      forzaPassword('abcdefghij12'),
      forzaPassword('Abcdefghij12!'),
      forzaPassword('Abcdefghijklmnop12!'),
    ])
    expect(visti.size, 'la barra di forza restituisce troppi pochi valori distinti').toBeGreaterThanOrEqual(4)
  })

  it('è DETERMINISTICA: la stessa password dà sempre lo stesso punteggio', () => {
    for (const p of ['', 'abc', 'nonna rosa 42', 'Nonna-Rosa-42-x!']) {
      expect(forzaPassword(p)).toBe(forzaPassword(p))
    }
  })

  it('è MONOTONA: inserire un carattere, ovunque, non abbassa mai il punteggio', () => {
    const rnd = generatore(20260901)
    const controesempi: string[] = []
    for (let i = 0; i < 4000; i++) {
      const n = Math.floor(rnd() * 22)
      const prima = Array.from({ length: n }, () => ALFABETO[Math.floor(rnd() * ALFABETO.length)]).join('')
      const pos = Math.floor(rnd() * (prima.length + 1))
      const c = ALFABETO[Math.floor(rnd() * ALFABETO.length)]
      const dopo = prima.slice(0, pos) + c + prima.slice(pos)
      if (forzaPassword(dopo) < forzaPassword(prima)) {
        controesempi.push(`«${prima}» (${forzaPassword(prima)}) → «${dopo}» (${forzaPassword(dopo)})`)
      }
    }
    expect(
      controesempi.slice(0, 5),
      'Aggiungendo un carattere la barra di forza è SCESA. Chi sta digitando la vedrebbe ' +
        'tornare indietro mentre continua a scrivere, e la leggerebbe come «sto peggiorando».',
    ).toEqual([])
  })

  it('è MONOTONA anche lungo una catena lunga (chi digita aggiunge un carattere alla volta)', () => {
    const rnd = generatore(7)
    const rotture: string[] = []
    for (let catena = 0; catena < 200; catena++) {
      let p = ''
      let precedente = forzaPassword(p)
      for (let passo = 0; passo < 30; passo++) {
        p += ALFABETO[Math.floor(rnd() * ALFABETO.length)]
        const ora = forzaPassword(p)
        if (ora < precedente) rotture.push(`«${p}»: ${precedente} → ${ora}`)
        precedente = ora
      }
    }
    expect(rotture.slice(0, 5)).toEqual([])
  })

  it('NON è la stessa cosa delle regole: valuta la robustezza, non l’ammissibilità', () => {
    // Un punteggio alto non promette che la password sia accettata, e non deve:
    // gli spazi ai bordi non rendono una password più debole, la rendono INAMMISSIBILE.
    // Tenerle separate è ciò che permette a `forzaPassword` di essere monotona.
    const conSpazi = ' Nonna-Rosa-42-x! '
    expect(forzaPassword(conSpazi)).toBeGreaterThan(0)
    expect(esito(conSpazi)).toBe('PASSWORD_CON_SPAZI_AI_BORDI')
  })
})

describe('regole-password resta importabile dal client', () => {
  it('non importa nulla di Node né del server', () => {
    // La ragione per cui questo modulo è nato separato da `password-temporanea.ts`
    // (che importa `randomInt` da `crypto`): la schermata di onboarding è un
    // componente `'use client'`, e un import server qui romperebbe la build sul
    // telefono di una famiglia. Affidarsi al tree-shaking sarebbe una scommessa
    // sul bundler, non una garanzia.
    const sorgente = readFileSync(path.join(process.cwd(), 'src/lib/auth/regole-password.ts'), 'utf8')
    const specificatori = [...sorgente.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    const vietati = specificatori.filter((s) =>
      /^(node:|crypto$|fs$|path$|next\/server|@supabase\/|@\/lib\/supabase|@\/lib\/logging)/.test(s),
    )
    expect(vietati, 'import non trasportabile nel bundle client').toEqual([])
    expect(/\brequire\s*\(/.test(sorgente), 'require() in un modulo che deve girare nel browser').toBe(false)
  })
})
