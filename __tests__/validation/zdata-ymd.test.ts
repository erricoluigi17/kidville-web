import { describe, it, expect } from 'vitest'
import { zDataOraLocale, zDataYMD } from '@/lib/validation/common'

// =============================================================================
// E1.2 — RC4: zDataYMD deve validare il CALENDARIO, non solo il formato.
//
// Prima del fix, una data sintatticamente valida ma inesistente (es. 2026-02-30)
// superava la regex e arrivava a Postgres (`.gte('data', ...)`), che lanciava
// il codice 22008 → la route rispondeva 500 invece di 400. Il validatore è
// CONDIVISO con attendance/mensa: il fix chiude la falla ovunque.
// =============================================================================

describe('zDataYMD — validità di calendario', () => {
  it('accetta una data reale', () => {
    expect(zDataYMD.safeParse('2026-07-20').success).toBe(true)
  })

  it('accetta il 29 febbraio di un anno bisestile', () => {
    expect(zDataYMD.safeParse('2024-02-29').success).toBe(true)
  })

  it('accetta il primo e l\'ultimo giorno del mese', () => {
    expect(zDataYMD.safeParse('2026-01-01').success).toBe(true)
    expect(zDataYMD.safeParse('2026-12-31').success).toBe(true)
  })

  it('rifiuta il 30 febbraio (giorno inesistente)', () => {
    expect(zDataYMD.safeParse('2026-02-30').success).toBe(false)
  })

  it('rifiuta il 29 febbraio di un anno NON bisestile', () => {
    expect(zDataYMD.safeParse('2026-02-29').success).toBe(false)
  })

  it('rifiuta il mese 13 e il giorno 99', () => {
    expect(zDataYMD.safeParse('2026-13-99').success).toBe(false)
  })

  it('rifiuta il mese 00', () => {
    expect(zDataYMD.safeParse('2026-00-10').success).toBe(false)
  })

  it('rifiuta il giorno 00', () => {
    expect(zDataYMD.safeParse('2026-07-00').success).toBe(false)
  })

  it('rifiuta il 31 aprile (aprile ha 30 giorni)', () => {
    expect(zDataYMD.safeParse('2026-04-31').success).toBe(false)
  })

  it('rifiuta comunque un formato errato (regola preesistente conservata)', () => {
    expect(zDataYMD.safeParse('20-07-2026').success).toBe(false)
    expect(zDataYMD.safeParse('2026/07/20').success).toBe(false)
    expect(zDataYMD.safeParse('').success).toBe(false)
  })
})

// =============================================================================
// `zDataOraLocale` — LA PROMESSA CHE NESSUN TEST SOSTENEVA.
//
// La docstring dello schema (`src/lib/validation/common.ts`) dichiara per esteso
// che l'ora è ANCORATA — `([01]\d|2[0-3]):[0-5]\d`, «non `\d{2}:\d{2}` che accetta
// `99:99`» — e che un ISO non passa. Fino a qui era una frase, non un fatto:
// sostituendo la regex con quella permissiva la suite intera restava verde con
// numeri identici (1358 file, 18826 test). Una promessa scritta che nessuno
// misura è una promessa che il prossimo refactor può togliere senza accorgersene.
//
// I casi qui sotto sono scelti perché ciascuno muore su un ramo DIVERSO:
//   · `99:99`, `24:00`, `23:60`  → la regex ancorata (i due bordi veri di
//                                  `([01]\d|2[0-3])` e di `[0-5]\d`)
//   · `2026-02-30T10:00`         → il `.refine(dataCalendarioValida)`, cioè il
//                                  CALENDARIO, che la regex non guarda (RC4)
//   · l'ISO e lo spazio          → la forma: sul filo passano le cifre che la
//                                  persona ha letto, non un istante già
//                                  interpretato dall'orologio del tablet
//
// La prova che questo blocco morde: si allarga la regex a `\d{2}:\d{2}` e i due
// test del primo gruppo diventano rossi (tre VALORI, ma due `it()`: la parola
// diceva «tre» perché contava i valori). Fatto, e non dedotto.
// =============================================================================

describe('zDataOraLocale — ora ancorata, calendario vero, nessun ISO', () => {
  it('🔴 rifiuta `99:99`: un\'ora è un\'ora, non due cifre qualsiasi', () => {
    // È il caso che l'intera consegna promette a parole e che nessun test
    // esercitava. `\d{2}:\d{2}` lo accetterebbe, e finirebbe in `istanteDaLocale`
    // a diventare `null` — cioè «nessuna scadenza» detto di un campo compilato.
    expect(zDataOraLocale.safeParse('2026-06-01T99:99').success).toBe(false)
  })

  it('rifiuta i due bordi veri: l\'ora 24 e il minuto 60', () => {
    // 24:00 è la mezzanotte che `<input type="datetime-local">` non scrive mai
    // (è `00:00` del giorno dopo) ed è il primo valore fuori da `2[0-3]`.
    expect(zDataOraLocale.safeParse('2026-06-01T24:00').success).toBe(false)
    // 23:60 è il primo valore fuori da `[0-5]\d`: l'ora sta nel range, il minuto no.
    expect(zDataOraLocale.safeParse('2026-06-01T23:60').success).toBe(false)
  })

  it('rifiuta il 30 febbraio: il CALENDARIO, non il formato', () => {
    // La regex la lascia passare (le cifre sono due e due); a fermarla è il
    // `.refine`. Senza, `2026-02-30T10:00` arriverebbe a Postgres come 22008 →
    // 500, che è il difetto RC4 un livello più in là.
    expect(zDataOraLocale.safeParse('2026-02-30T10:00').success).toBe(false)
    expect(zDataOraLocale.safeParse('2026-02-29T10:00').success).toBe(false) // non bisestile
  })

  it('rifiuta un ISO e lo spazio al posto della `T`', () => {
    // Un ISO porta con sé l'orologio E il fuso del dispositivo che l'ha composto:
    // qui passano le cifre dell'orologio a muro, e l'istante lo fa il server.
    expect(zDataOraLocale.safeParse('2026-06-01T16:00:00.000Z').success).toBe(false)
    expect(zDataOraLocale.safeParse('2026-06-01T18:00:00').success).toBe(false)
    expect(zDataOraLocale.safeParse('2026-06-01 18:00').success).toBe(false)
    // E una data nuda non è una data e ora: è la scadenza «a metà» da cui questo
    // schema nasce (vedi il `@deprecated` di `zScadenzaAvviso`).
    expect(zDataOraLocale.safeParse('2026-06-01').success).toBe(false)
  })

  it('accetta la forma buona, estremi compresi', () => {
    expect(zDataOraLocale.safeParse('2026-06-01T18:00').success).toBe(true)
    expect(zDataOraLocale.safeParse('2026-06-01T00:00').success).toBe(true)
    expect(zDataOraLocale.safeParse('2026-06-01T23:59').success).toBe(true)
  })
})
