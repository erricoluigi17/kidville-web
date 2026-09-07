import { describe, it, expect } from 'vitest'
import {
  aOrarioIso,
  oraDiRoma,
  minutiDiRoma,
  oraDiRomaAdesso,
} from '@/lib/presenze/orario'

/**
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 *
 * `presenze.orario_entrata` e `orario_uscita` sono `text`, e in produzione (misurato
 * il 2026-09-07) ci convivono TRE forme scritte da tre epoche del prodotto:
 *
 *   · 1.101 righe  `2026-09-07T10:35:04.428Z`   ISO con fuso — lo 0-6, `toISOString()`
 *   ·    10 righe  `08:45`                       HH:MM nudo — storico e seed E2E
 *   ·     4 righe  `2026-09-04T09:40:00`         ISO NAÏVE — la primaria, `${data}T${ora}:00`
 *
 * Quattro lettori le interpretavano in tre modi diversi, e nessuno dei tre era
 * d'accordo con gli altri:
 *
 *   · `PresenzeTodayCard` faceva `.slice(0,5)` → sull'ISO rendeva la stringa «2026-»,
 *     che 490 genitori leggevano sulla home come «Ingresso alle 2026-»;
 *   · `oreAssenza` faceva `getHours()`, cioè l'ora LOCALE DEL PROCESSO (UTC su
 *     Vercel) → l'ISO valeva due ore in meno, e l'`HH:MM` valeva `null`, cioè un
 *     ritardo contato ZERO;
 *   · la riga dell'appello formattava con `Intl` + `Europe/Rome`, e sola aveva ragione.
 *
 * ⚠️ IL DIFETTO DI `getHours()` NON ERA VIVO, ED È LA PARTE PEGGIORE. Sulle righe
 * naïve della primaria si annullava da solo — JS le parsa come ora locale e
 * `getHours()` le rilegge come ora locale — quindi con `TZ=UTC` il conto tornava
 * PER CASO. Il giorno in cui qualcuno scrive un istante `…Z` in una riga che
 * `calcolaOreAssenza` legge, si arma. La rettifica manuale dell'orario è
 * esattamente quel writer: correggere il lettore non è ereditare un bug, è
 * evitare di causarlo.
 *
 * ⚠️ GLI ATTESI QUI SONO ANCORATI A ROMA, NON AL `TZ` DEL RUNNER. Questo file deve
 * dare lo stesso esito con `TZ=UTC npx vitest run` e con `TZ=Europe/Rome`. Se un
 * giorno diverge, è tornato il difetto: non si "aggiusta l'atteso", si guarda il
 * motore.
 */

describe('minutiDiRoma — minuti da mezzanotte, letti a Roma', () => {
  it('ISO con fuso: 10:35Z d\'estate sono le 12:35 italiane', () => {
    expect(minutiDiRoma('2026-09-07T10:35:04.428Z')).toBe(12 * 60 + 35)
  })

  it('ISO con fuso: 10:35Z d\'INVERNO sono le 11:35 — l\'offset non è cablato', () => {
    expect(minutiDiRoma('2026-01-15T10:35:00Z')).toBe(11 * 60 + 35)
  })

  it('ISO naïve: le cifre sono già ora italiana, e non si passa da new Date()', () => {
    expect(minutiDiRoma('2026-09-04T09:40:00')).toBe(9 * 60 + 40)
  })

  it('ISO naïve d\'inverno: stessa lettura letterale, nessuna conversione', () => {
    expect(minutiDiRoma('2026-01-04T09:40:00')).toBe(9 * 60 + 40)
  })

  it('HH:MM nudo: oggi vale null e 19 righe non sono contate', () => {
    expect(minutiDiRoma('08:45')).toBe(8 * 60 + 45)
  })

  it('HH:MM:SS — la quarta forma, quella che PresenzeTodayCard si aspettava', () => {
    expect(minutiDiRoma('08:45:00')).toBe(8 * 60 + 45)
  })

  it('offset esplicito diverso da Z', () => {
    expect(minutiDiRoma('2026-06-08T09:30:00+02:00')).toBe(9 * 60 + 30)
  })

  it.each([null, '', '   ', 'boh', '99:99', '25:00', '2026-13-45T99:99:99Z'])(
    'ciò che non è un orario resta null: %p',
    (v) => {
      expect(minutiDiRoma(v as string | null)).toBeNull()
    },
  )
})

describe('oraDiRoma — la stringa HH:MM da mostrare', () => {
  it('ISO con fuso → ora italiana, non UTC', () => {
    expect(oraDiRoma('2026-09-07T10:35:04.428Z')).toBe('12:35')
  })

  it('la riga che 490 genitori leggevano come «2026-»', () => {
    expect(oraDiRoma('2026-09-07T10:35:04.428Z')).not.toContain('2026')
  })

  it('ISO naïve → le proprie cifre', () => {
    expect(oraDiRoma('2026-09-04T09:40:00')).toBe('09:40')
  })

  it('HH:MM → sé stesso, normalizzato a due cifre', () => {
    expect(oraDiRoma('08:45')).toBe('08:45')
    expect(oraDiRoma('8:45')).toBe('08:45')
  })

  it('HH:MM:SS → si perdono i secondi, non il resto', () => {
    expect(oraDiRoma('08:45:30')).toBe('08:45')
  })

  it('mezzanotte resta 00:00 e non diventa 24:00', () => {
    expect(oraDiRoma('2026-09-07T22:00:00Z')).toBe('00:00')
  })

  it.each([null, '', 'boh'])('non-orari → null: %p', (v) => {
    expect(oraDiRoma(v as string | null)).toBeNull()
  })
})

describe('aOrarioIso — da HH:MM italiane all\'istante da scrivere', () => {
  it('ora legale: 08:45 a Roma sono le 06:45 UTC', () => {
    expect(aOrarioIso('2026-09-07', '08:45')).toBe('2026-09-07T06:45:00.000Z')
  })

  it('ora solare: lo stesso 08:45 è le 07:45 UTC — l\'offset si rilegge, non si cabla', () => {
    expect(aOrarioIso('2026-01-15', '08:45')).toBe('2026-01-15T07:45:00.000Z')
  })

  it('andata e ritorno: quello che scrivo è quello che rileggo', () => {
    for (const [data, ora] of [
      ['2026-09-07', '08:45'],
      ['2026-01-15', '08:45'],
      ['2026-03-29', '14:00'],
      ['2026-10-25', '14:00'],
    ] as const) {
      expect(oraDiRoma(aOrarioIso(data, ora))).toBe(ora)
    }
  })

  it.each(['99:99', '25:00', '8:5', '', 'boh'])('ora non valida → null: %p', (ora) => {
    expect(aOrarioIso('2026-09-07', ora)).toBeNull()
  })

  it.each(['2026-02-30', '2026-13-01', 'ieri', ''])('data non valida → null: %p', (data) => {
    expect(aOrarioIso(data, '08:45')).toBeNull()
  })
})

describe('oraDiRomaAdesso', () => {
  it('rende HH:MM, e le cifre sono quelle di Roma', () => {
    const finto = new Date('2026-09-07T10:35:00Z')
    expect(oraDiRomaAdesso(finto)).toBe('12:35')
  })

  it('la forma è sempre HH:MM', () => {
    expect(oraDiRomaAdesso()).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
  })
})
