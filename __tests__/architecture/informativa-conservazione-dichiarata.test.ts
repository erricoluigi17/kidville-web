import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RADICE = process.cwd()
const INFORMATIVA = join(RADICE, 'src/app/privacy/page.tsx')
const ROUTE_RETENTION = join(RADICE, 'src/app/api/gdpr/retention-iscrizioni/route.ts')

const informativa = readFileSync(INFORMATIVA, 'utf8')
const route = readFileSync(ROUTE_RETENTION, 'utf8')

/**
 * LOCK — L'INFORMATIVA E IL CODICE DEVONO DIRE LO STESSO NUMERO.
 *
 * ─── LA STORIA (rilievo T06-F2, collaudo del 2026-08-03) ────────────────────
 *
 * La sezione «Conservazione dei dati» elencava sei categorie e non ne aveva
 * nessuna per la domanda di chi si pre-iscrive e NON viene accolto. Intanto il
 * codice una regola ce l'aveva — 24 mesi, decisione del titolare del 2026-08-01,
 * in `retention-iscrizioni/route.ts` — e cancellava la domanda e il documento
 * d'identità allegato senza che l'informativa lo avesse mai detto a nessuno.
 *
 * Al 2026-08-03 sono 263 domande, con 152 codici fiscali di minori.
 *
 * ─── PERCHÉ UN LOCK E NON SOLO LA CORREZIONE ────────────────────────────────
 *
 * Perché il difetto non è la frase mancante: è che i due numeri vivono in due
 * posti che nessuno confronta. Il giorno in cui il titolare cambia idea sui 24
 * mesi, `MESI_CONSERVAZIONE` si aggiorna e l'informativa resta indietro — e
 * un'informativa che promette un termine diverso da quello applicato non è un
 * refuso: è la dichiarazione con cui l'interessato ha prestato il consenso
 * (art. 13 §2 lett. a GDPR).
 *
 * È la stessa classe di difetto che questo repo ha già pagato tre volte in
 * quattro giorni: `CLAUDE.md` che diceva «pre-lancio, nessun dato reale» con 227
 * domande in produzione; la docstring di `obliaFotoNewsAlunno` che si diceva non
 * chiamata mentre lo era; e la migrazione `20260731165941` che dichiara «nessuna
 * retention» mentre la route cancellava. Un documento che descrive un mondo che
 * non c'è più è peggio di nessun documento — e qui il documento è quello che
 * leggono le famiglie.
 */
describe('lock · l’informativa dichiara la conservazione delle domande non accolte', () => {
  it('il codice ha una regola di conservazione, e si legge (sanity)', () => {
    // Se questa cade, tutto il resto sarebbe verde sul vuoto.
    const m = route.match(/const MESI_CONSERVAZIONE = (\d+)/)
    expect(m, '`MESI_CONSERVAZIONE` non si trova più in retention-iscrizioni/route.ts').not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
  })

  it('l’informativa parla delle domande NON ACCOLTE', () => {
    // La sezione esisteva e copriva solo chi è già iscritto: la famiglia che
    // compila e non viene accolta non trovava sé stessa da nessuna parte.
    const sezione = informativa.slice(informativa.indexOf('Conservazione dei dati'))
    expect(
      /pre-iscrizione non accolte|non accolte/i.test(sezione),
      'la sezione «Conservazione dei dati» non dice per quanto si conservano le domande di chi ' +
        'si pre-iscrive e non viene accolto — mentre il codice le cancella a scadenza',
    ).toBe(true)
  })

  it('e dichiara LO STESSO numero di mesi che il codice applica', () => {
    const mesi = Number(route.match(/const MESI_CONSERVAZIONE = (\d+)/)![1])
    // In un testo legale il numero si scrive in lettere: si accetta la cifra o la
    // parola, perché è la COERENZA a essere sorvegliata, non la tipografia.
    const inLettere: Record<number, string> = {
      12: 'dodici', 18: 'diciotto', 24: 'ventiquattro', 36: 'trentasei', 48: 'quarantotto',
    }
    const parola = inLettere[mesi]
    const sezione = informativa.slice(informativa.indexOf('Conservazione dei dati'))
    const dichiarato =
      new RegExp(`${mesi}\\s*mesi`, 'i').test(sezione) ||
      (parola !== undefined && new RegExp(`${parola}\\s*mesi`, 'i').test(sezione))
    expect(
      dichiarato,
      `Il codice cancella le domande non accolte dopo ${mesi} mesi, e l'informativa non dichiara ` +
        `quel termine. Se il numero è cambiato, va cambiato ANCHE nell'informativa: è la ` +
        `dichiarazione su cui la famiglia ha prestato il consenso (art. 13 §2 lett. a GDPR), ` +
        `non una nota interna.` +
        (parola === undefined
          ? ` (Nessuna forma in lettere nota per ${mesi}: aggiungila alla mappa di questo lock.)`
          : ''),
    ).toBe(true)
  })
})
