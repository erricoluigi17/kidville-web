import { describe, it, expect } from 'vitest'
import {
  inizioGiornoCivile,
  fineGiornoCivile,
  istanteDaLocale,
  oraCivile,
} from '@/lib/format/confini-giorno'
import { dataCivile } from '@/i18n/config'

/**
 * ─── I DUE ESTREMI DI UN GIORNO ITALIANO, IN ISTANTI ─────────────────────────
 *
 * Una barra filtri manda `?creataDa=2026-09-01`. La colonna che riceve quel
 * filtro è una `timestamptz`, cioè un ISTANTE: `gte('creata_il', '2026-09-01')`
 * lo fa leggere a Postgres come `2026-09-01 00:00:00` **nel fuso della
 * sessione**, che su Supabase è UTC. A Roma quell'istante è l'01:00 o le 02:00
 * del mattino: tutto ciò che è arrivato fra mezzanotte e le due del 1° settembre
 * finisce nel 31 agosto, e la segreteria che filtra «oggi» non lo vede.
 *
 * Non è teoria: è lo stesso difetto misurato il 2026-08-01 alle 01:08 che ha
 * fatto sparire un incasso vero da un KPI, e per cui esiste `dataCivile()`.
 * Qui serve la strada inversa — da un giorno civile ai due istanti che lo
 * delimitano — e i casi che contano sono i due giorni in cui l'ora cambia.
 *
 * I valori attesi non sono dedotti a mente: sono stati calcolati con `Intl` e
 * `timeZone: 'Europe/Rome'` prima di scrivere il test.
 */
describe('confini di un giorno civile italiano', () => {
  it('estate (UTC+2): il 1° settembre comincia il 31 agosto alle 22:00Z', () => {
    expect(inizioGiornoCivile('2026-09-01')).toBe('2026-08-31T22:00:00.000Z')
    expect(fineGiornoCivile('2026-09-01')).toBe('2026-09-01T21:59:59.999Z')
  })

  it('inverno (UTC+1): il 15 gennaio comincia il 14 alle 23:00Z', () => {
    expect(inizioGiornoCivile('2026-01-15')).toBe('2026-01-14T23:00:00.000Z')
    expect(fineGiornoCivile('2026-01-15')).toBe('2026-01-15T22:59:59.999Z')
  })

  it('il giorno in cui l\'ora VA AVANTI (29/03/2026) ha due offset diversi ai due estremi', () => {
    // 00:00 locali sono ancora +01:00 — l'ora cambia alle 02:00.
    expect(inizioGiornoCivile('2026-03-29')).toBe('2026-03-28T23:00:00.000Z')
    // …e le 23:59 sono già +02:00. Un solo offset per tutto il giorno
    // sbaglierebbe uno dei due estremi di un'ora piena.
    expect(fineGiornoCivile('2026-03-29')).toBe('2026-03-29T21:59:59.999Z')
  })

  it('il giorno in cui l\'ora TORNA INDIETRO (25/10/2026) è lungo 25 ore', () => {
    expect(inizioGiornoCivile('2026-10-25')).toBe('2026-10-24T22:00:00.000Z')
    expect(fineGiornoCivile('2026-10-25')).toBe('2026-10-25T22:59:59.999Z')
    const durata =
      Date.parse(fineGiornoCivile('2026-10-25') as string) -
      Date.parse(inizioGiornoCivile('2026-10-25') as string)
    expect(Math.round(durata / 3_600_000)).toBe(25)
  })

  it('una data che sul calendario non esiste non produce un estremo: `null`', () => {
    // `new Date('2026-02-30')` scivolerebbe al 2 marzo in silenzio. Un estremo
    // sbagliato di due giorni è peggio di nessun estremo: chi filtra vedrebbe
    // righe che non ha chiesto e non saprebbe perché.
    for (const brutta of ['2026-02-30', '2026-13-01', '1-1-2026', '', 'oggi']) {
      expect(inizioGiornoCivile(brutta)).toBeNull()
      expect(fineGiornoCivile(brutta)).toBeNull()
    }
  })

  it('l\'estremo finale è INCLUSIVO: l\'ultimo millisecondo del giorno c\'è', () => {
    // «Dal 1° al 31» comprende il 31 — è il contratto del motore dei filtri
    // (`motore.ts`), e l'ultimo giorno che sparisce è il difetto più comune di
    // tutti: si nota solo quando manca la registrazione di fine mese.
    const fine = fineGiornoCivile('2026-09-30') as string
    const inizioDopo = inizioGiornoCivile('2026-10-01') as string
    expect(Date.parse(inizioDopo) - Date.parse(fine)).toBe(1)
  })
})

/**
 * ─── IL CAMPO DATA+ORA: ANDATA, RITORNO, E I DUE GIORNI STORTI ───────────────
 *
 * `<input type="datetime-local">` manda `YYYY-MM-DDTHH:MM` — cifre su un orologio
 * a muro italiano, senza fuso. `istanteDaLocale` le ancora a `Europe/Rome`,
 * `oraCivile` fa la strada di ritorno per riempire di nuovo il campo. Il giro
 * completo è il test che conta: se andata e ritorno non si annullano, una
 * segreteria che riapre un avviso in modifica e risalva senza toccare niente
 * sposta la scadenza ogni volta.
 *
 * ⚠️ I valori dei due giorni di cambio ora NON sono ricalcolati qui: sono gli
 * stessi offset già fissati sopra (+01:00 fino alle 02:00 del 29 marzo, +02:00
 * fino alle 03:00 del 25 ottobre). I due istanti delle ore «storte» sono stati
 * ESEGUITI prima di scrivere il test, non dedotti — è la stessa disciplina della
 * testata di questo file.
 */
describe('data e ora locali italiane ↔ istante', () => {
  it('estate e inverno: le stesse cifre sono due istanti diversi', () => {
    // Giugno: +02:00. Le 18:00 di Roma sono le 16:00Z.
    expect(istanteDaLocale('2026-06-01T18:00')).toBe('2026-06-01T16:00:00.000Z')
    // Gennaio: +01:00. Le 08:00 di Roma sono le 07:00Z.
    expect(istanteDaLocale('2026-01-15T08:00')).toBe('2026-01-15T07:00:00.000Z')
  })

  it('i secondi sono a .000: è un istante puntuale, non l\'estremo di un giorno', () => {
    // Il `.999` è il contratto di `fineGiornoCivile` (estremo INCLUSIVO di un
    // filtro «dal … al …»), non di una scadenza. Confonderli darebbe a ogni
    // scadenza un secondo di vita in più che nessuno ha chiesto.
    expect(istanteDaLocale('2026-12-31T23:59')).toBe('2026-12-31T22:59:00.000Z')
  })

  it('29/03/2026 alle 02:30 — un\'ora che a Roma NON ESISTE', () => {
    // Alle 02:00 l'orologio salta a 03:00: le 02:30 non accadono mai. Il campo
    // del browser le lascia digitare lo stesso, quindi il risultato dev'essere
    // DETERMINISTICO e scritto — «giusto» non è un'opzione disponibile.
    expect(istanteDaLocale('2026-03-29T02:30')).toBe('2026-03-29T01:30:00.000Z')
    // A Roma quell'istante sono le 03:30: l'ora inesistente scivola AVANTI di
    // un'ora, cioè finisce sullo stesso istante di `03:30`.
    expect(oraCivile('2026-03-29T01:30:00.000Z')).toBe('03:30')
    expect(istanteDaLocale('2026-03-29T03:30')).toBe(istanteDaLocale('2026-03-29T02:30'))
  })

  it('25/10/2026 alle 02:30 — un\'ora che a Roma ESISTE DUE VOLTE', () => {
    // Alle 03:00 l'orologio torna a 02:00: le 02:30 passano una volta con
    // l'offset estivo (00:30Z) e una con quello invernale (01:30Z).
    expect(istanteDaLocale('2026-10-25T02:30')).toBe('2026-10-25T01:30:00.000Z')
    // Viene scelta la SECONDA, cioè la più tarda: per una scadenza lo scarto cade
    // dalla parte che lascia la finestra più larga, mai più stretta.
    expect(Date.parse('2026-10-25T01:30:00.000Z') - Date.parse('2026-10-25T00:30:00.000Z')).toBe(
      3_600_000,
    )
    // Le due letture di `02:30` riportano lo stesso `HH:MM` — è il senso di «esiste
    // due volte», ed è il motivo per cui il ritorno da solo non basta a distinguerle.
    expect(oraCivile('2026-10-25T00:30:00.000Z')).toBe('02:30')
    expect(oraCivile('2026-10-25T01:30:00.000Z')).toBe('02:30')
    // …e le 03:30 restano le 03:30: l'ora doppia non mangia quella dopo.
    expect(istanteDaLocale('2026-10-25T03:30')).toBe('2026-10-25T02:30:00.000Z')
  })

  it('IL GIRO COMPLETO: salvo 18:00, rileggo, formatto a Roma → 18:00', () => {
    // È il test che protegge la segreteria dallo scorrimento silenzioso: senza
    // `oraCivile`, riaprire un avviso mostrerebbe l'ora UTC (16:00), e ogni
    // salvataggio successivo sposterebbe la scadenza indietro di due ore.
    const digitato = '2026-06-01T18:00'
    const inColonna = istanteDaLocale(digitato) as string
    const riletto = `${dataCivile(new Date(inColonna))}T${oraCivile(inColonna)}`
    expect(riletto).toBe(digitato)
  })

  it('il giro completo regge anche nei due giorni di cambio ora — fuori dalle ore storte', () => {
    for (const digitato of [
      '2026-03-29T00:30', // prima del salto: ancora +01:00
      '2026-03-29T12:00', // dopo il salto: già +02:00
      '2026-10-25T12:00', // dopo il ritorno: +01:00
      '2026-12-31T23:59',
      '2026-01-01T00:00',
    ]) {
      const inColonna = istanteDaLocale(digitato) as string
      expect(`${dataCivile(new Date(inColonna))}T${oraCivile(inColonna)}`).toBe(digitato)
    }
  })

  it('la mezzanotte esce `00:00` e non `24:00`', () => {
    // `hour12: false` lascia al locale la scelta fra il ciclo h23 e h24, e nel
    // ciclo h24 la mezzanotte si stampa `24:00` — un valore che
    // `<input type="datetime-local">` rifiuta lasciando il campo VUOTO. Per questo
    // `oraCivile` dichiara `hourCycle: 'h23'` invece di lasciar decidere.
    expect(oraCivile('2026-06-01T22:00:00.000Z')).toBe('00:00') // 00:00 del 2 giugno a Roma
    expect(oraCivile('2026-01-14T23:00:00.000Z')).toBe('00:00') // 00:00 del 15 gennaio a Roma
  })

  it('ciò che non è quella forma non diventa un istante: `null`', () => {
    // ⚠️ `2026-06-01T18:00:00.000Z` è un ISO VALIDO, e viene rifiutato apposta: qui
    // passano le cifre che la persona ha digitato, non un istante già interpretato
    // dall'orologio (e dal fuso) del tablet. Il perché per esteso sta in
    // `zDataOraLocale`, `@/lib/validation/common`.
    for (const brutta of [
      '2026-06-01T18:00:00.000Z',
      '2026-06-01T18:00:00',
      '2026-06-01 18:00',
      '2026-06-01',
      '2026-02-30T10:00', // il calendario, non il formato
      '2026-13-01T10:00',
      '',
      'domani alle sei',
    ]) {
      expect(istanteDaLocale(brutta)).toBeNull()
    }
  })

  it('un istante illeggibile riempie il campo con il vuoto, che si vede', () => {
    // `oraCivile` serve a RIEMPIRE un campo: un `''` lascia il campo vuoto e la
    // segreteria se ne accorge. Chi deve DECIDERE su una scadenza usa invece
    // `@/lib/avvisi/scadenze`, che su una stringa malformata lancia — lì un valore
    // mancato che scivola via significherebbe «nessuna scadenza».
    expect(oraCivile('non una data')).toBe('')
    expect(oraCivile('')).toBe('')
  })
})
