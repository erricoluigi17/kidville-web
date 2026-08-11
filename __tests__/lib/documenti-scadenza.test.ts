import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, riga } from '../fixtures/sorgente'
import { dataCivile } from '@/i18n/config'
import { PERSONALE_LIMITI } from '@/lib/forms/personale-template'
import {
  MAX_RISOLLECITI_EMAIL,
  SOGLIA_MAX,
  SOGLIA_SCADUTO,
  SOGLIE,
  aggiungiGiorni,
  emailRisollecitoDovuta,
  giorniDaEpoca,
  giorniResidui,
  numeroRisollecito,
  sogliaRaggiunta,
  vaAvvisato,
} from '@/lib/anagrafica/scadenze'

// =============================================================================
// L'ALLARME DI SCADENZA DEI DOCUMENTI DEL PERSONALE — la logica pura.
//
// QUALI DIFETTI REALI IMPEDISCE QUESTO FILE. Sono cinque, e nessuno di essi
// romperebbe niente: tutti e cinque manderebbero un avviso il giorno sbagliato,
// o due volte, o mai — cioè guasti che si vedono solo dal fatto che una persona
// lavora con un documento scaduto e nessuno l'ha avvisata.
//
//  1. IL CONFINE. `giorni <= 30` e `giorni < 30` differiscono di un giorno su un
//     preavviso che serve a prendere un appuntamento in Comune. E `giorni === 0`
//     NON è «scaduto»: un documento d'identità è valido fino al giorno di
//     scadenza compreso, quindi dire a qualcuno che il suo documento è scaduto
//     mentre è ancora buono è una constatazione FALSA in un fascicolo del
//     personale.
//
//  2. IL FUSO. `(Date.parse(a) - Date.parse(b)) / 86400000` attraversa il cambio
//     dell'ora legale e restituisce `30.041…`: la soglia «30 giorni» scatta un
//     giorno prima o dopo a seconda del mese. Il prodotto vive in `Europe/Rome`,
//     il processo su Vercel gira in UTC, e questo lavoro parte DI NOTTE — cioè
//     esattamente nelle due ore in cui i due orologi stanno in giorni diversi.
//     È la classe di difetto che `__tests__/architecture/date-senza-fuso.test.ts`
//     sorveglia da un'altra porta, e che qui si prova sul comportamento.
//
//  3. LA DATA CHE NON ESISTE. `new Date('2026-02-30')` scivola al 2 marzo in
//     silenzio: un refuso in una data di scadenza diventerebbe un avviso in
//     ritardo di due giorni che nessuno può più ricostruire.
//
//  4. IL DOPPIO INVIO. La stessa soglia annunciata due volte è l'inizio della
//     raffica quotidiana, e un allarme quotidiano si impara a ignorare — è
//     scritto testualmente nella migrazione che ha creato le due colonne di
//     stato.
//
//  5. IL RISOLLECITO CHE SI ALLONTANA DA SOLO. Un confronto sui millisecondi
//     manca il settimo giorno per i secondi di jitter del cron, il risollecito
//     slitta al giorno dopo, e da lì in poi la cadenza diventa di otto giorni,
//     poi di nove: un promemoria «settimanale» che si dirada finché non sparisce.
//
//  6. IL RISOLLECITO CHE NON FINISCE MAI — il difetto opposto al n. 5, e trovato
//     dal revisore il 2026-08-12. `vaAvvisato` fa ripartire l'avviso ogni sette
//     giorni finché il documento non viene rinnovato o `cessato_il` valorizzato,
//     senza un termine: una persona che per mesi non riesce a rinnovare — o un
//     rapporto chiuso che nessuno ha registrato — produce un'EMAIL A SETTIMANA a
//     lei e a ogni membro della segreteria, per sempre. È la stessa dinamica del
//     n. 4 alla cadenza di una settimana: si impara a ignorare l'avviso, e con
//     esso quello dei 7 giorni, che è quello che serve davvero.
//
//  7. IL TETTO CHE NASCE ESAURITO — il difetto che la correzione del n. 6 ha
//     introdotto, trovato dal revisore il 2026-08-12 ESEGUENDO la route vera. Il
//     tetto contava i solleciti come `floor(giorni_scaduti / 7)`, cioè
//     dall'ANZIANITÀ DELLA SCADENZA e non da quanti ne erano stati mandati. Per
//     una dipendente storica inserita con la carta d'identità già scaduta da
//     mesi — la popolazione che questo modulo dichiara di esistere per servire —
//     il contatore partiva oltre il tetto e la PRIMA email non partiva mai, né a
//     lei né alla segreteria: `notifiche=2, email=[], email_oltre_tetto=1`, con
//     la riga di `warn` che dichiarava «l'email non riparte» mentre non era mai
//     partita.
//
//     ⚠️ E LA SUITE NON POTEVA VEDERLO: tutti e tre i test del tetto costruivano
//     la riga con `scadenza_soglia_avvisata: 0`, cioè assumevano — senza dirlo —
//     che «scaduto da tanto» implicasse «già sollecitato tante volte». È vero per
//     chi invecchia dentro il sistema, falso per chi ci entra. Da qui i tre test
//     🔴 che qui sotto partono da `ultimaSoglia: null` e da un preavviso.
// =============================================================================

const SORGENTE = path.join(process.cwd(), 'src/lib/anagrafica/scadenze.ts')

/** Il giorno `n` dopo (o prima, se negativo) di una data — solo per leggibilità. */
const giorno = (base: string, n: number) => aggiungiGiorni(base, n)

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · i confini della soglia', () => {
  const OGGI = '2026-08-11'

  // La tabella è ESATTAMENTE quella chiesta al collaudo, un caso per riga: se
  // qualcuno sposta un `<=` in un `<`, cade la riga che lo nomina.
  const CASI: { giorni: number; attesa: number | null; perche: string }[] = [
    { giorni: -1, attesa: SOGLIA_SCADUTO, perche: 'scaduto da ieri: non è più un preavviso' },
    { giorni: 0, attesa: 7, perche: 'scade OGGI, ed è ancora valido oggi: non è «scaduto»' },
    { giorni: 7, attesa: 7, perche: 'il 7 comprende il settimo giorno' },
    { giorni: 8, attesa: 30, perche: 'oltre il 7 si ricade nella soglia superiore' },
    { giorni: 30, attesa: 30, perche: 'il 30 comprende il trentesimo giorno' },
    { giorni: 60, attesa: 60, perche: 'il 60 comprende il sessantesimo giorno' },
    { giorni: 89, attesa: 90, perche: 'dentro la finestra dei 90' },
    { giorni: 90, attesa: 90, perche: 'il 90 comprende il novantesimo giorno' },
    { giorni: 91, attesa: null, perche: 'troppo presto: non si dice ancora niente' },
    { giorni: 3650, attesa: null, perche: 'un documento nuovo non produce nessun avviso' },
  ]

  for (const { giorni, attesa, perche } of CASI) {
    it(`${giorni} giorni → ${attesa === null ? 'nessuna soglia' : attesa} (${perche})`, () => {
      expect(sogliaRaggiunta(giorni)).toBe(attesa)
    })
  }

  it('i confini si reggono anche passando dalle DATE, non solo dai numeri', () => {
    // Il difetto che questa asserzione impedisce è la coppia di funzioni che
    // «funziona» separatamente: `giorniResidui` giusta, `sogliaRaggiunta` giusta,
    // e in mezzo un fuori-di-uno che nessuna delle due prova da sola.
    expect(sogliaRaggiunta(giorniResidui(giorno(OGGI, -1), OGGI))).toBe(SOGLIA_SCADUTO)
    expect(sogliaRaggiunta(giorniResidui(OGGI, OGGI))).toBe(7)
    expect(sogliaRaggiunta(giorniResidui(giorno(OGGI, 90), OGGI))).toBe(90)
    expect(sogliaRaggiunta(giorniResidui(giorno(OGGI, 91), OGGI))).toBeNull()
  })

  it('un documento scaduto da mesi resta «scaduto», non torna a essere un preavviso', () => {
    // Se `giorni < 0` non fosse il PRIMO ramo, un valore molto negativo potrebbe
    // ricadere in un `<= 7` scritto male e produrre «scade fra una settimana» su
    // un documento fuori corso da un anno.
    expect(sogliaRaggiunta(giorniResidui('2025-01-01', OGGI))).toBe(SOGLIA_SCADUTO)
    expect(giorniResidui('2025-01-01', OGGI)).toBeLessThan(-200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · i giorni si contano sul calendario, non sugli orologi', () => {
  it('il cambio dell’ora LEGALE non sposta la soglia di un giorno', () => {
    // L'ultima domenica d'ottobre 2026 è il 25: quella notte, a Roma, ha 25 ore.
    // `(Date.parse('2026-10-25') - Date.parse('2026-09-25')) / 86_400_000` in un
    // processo che vive in Europe/Rome NON fa 30 tondi, ed è il difetto.
    expect(giorniResidui('2026-10-25', '2026-09-25')).toBe(30)
    expect(Number.isInteger(giorniResidui('2026-10-25', '2026-09-25'))).toBe(true)

    // E l'ultima domenica di marzo (29 marzo 2026), la notte da 23 ore.
    expect(giorniResidui('2026-03-29', '2026-02-27')).toBe(30)
  })

  it('l’anno bisestile è contato, il 29 febbraio esiste', () => {
    expect(giorniResidui('2028-03-01', '2028-02-28')).toBe(2)
    expect(giorniResidui('2027-03-01', '2027-02-28')).toBe(1)
    // Il 2100 non è bisestile (divisibile per 100 e non per 400): è il caso su
    // cui cadono le formule scritte a mano con il solo `% 4`.
    expect(giorniDaEpoca('2100-02-29')).toBeNaN()
    expect(giorniDaEpoca('2000-02-29')).not.toBeNaN()
  })

  it('un anno intero è 365 giorni, e un anno bisestile 366', () => {
    expect(giorniResidui('2027-01-01', '2026-01-01')).toBe(365)
    expect(giorniResidui('2029-01-01', '2028-01-01')).toBe(366)
  })

  it('`aggiungiGiorni` attraversa il fine mese e il fine anno', () => {
    expect(aggiungiGiorni('2026-08-11', 90)).toBe('2026-11-09')
    expect(aggiungiGiorni('2026-12-31', 1)).toBe('2027-01-01')
    expect(aggiungiGiorni('2028-02-28', 1)).toBe('2028-02-29')
    expect(aggiungiGiorni('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('CONTROLLO INCROCIATO: la conversione coincide con il calendario di `Intl`', () => {
    // Senza questo controllo, un errore SISTEMATICO nell'algoritmo di conversione
    // (uno sfasamento di un giorno su tutte le date) resterebbe invisibile: tutte
    // le differenze tornerebbero comunque giuste, e il difetto emergerebbe solo
    // dove il numero incontra una data vera — cioè nella clausola SQL del cron.
    for (const ymd of ['1970-01-01', '2000-02-29', '2026-08-11', '2026-11-09', '2100-03-01']) {
      const daEpoca = giorniDaEpoca(ymd)
      const ricostruita = dataCivile(new Date(Date.UTC(1970, 0, 1 + daEpoca, 12)))
      expect(ricostruita, `${ymd} non si ricostruisce dal suo numero d'ordine`).toBe(ymd)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · una data che non esiste non è «quasi» una data', () => {
  const NON_DATE = [
    '2026-02-30', // il 30 febbraio: `new Date` lo fa scivolare al 2 marzo
    '2027-02-29', // il 2027 non è bisestile
    '2026-13-01', // mese 13
    '2026-00-10', // mese 0
    '2026-08-00', // giorno 0
    '2026-08-32',
    '11/08/2026', // formato italiano: giusto per un umano, non per una colonna `date`
    '2026-8-11', // senza lo zero: non è il formato di Postgres
    '',
    'domani',
  ]

  for (const valore of NON_DATE) {
    it(`«${valore}» non produce un numero, produce NaN`, () => {
      expect(giorniDaEpoca(valore)).toBeNaN()
      expect(giorniResidui(valore, '2026-08-11')).toBeNaN()
      expect(aggiungiGiorni(valore, 90)).toBe('')
    })
  }

  it('NaN non diventa MAI una soglia: nessun avviso su un dato illeggibile', () => {
    // Il verso conta: una data illeggibile deve produrre SILENZIO, non «scaduto».
    // Al contrario, un refuso in anagrafica farebbe partire a tutta la sede
    // l'avviso «documento scaduto» su una persona che ha il documento in regola.
    expect(sogliaRaggiunta(NaN)).toBeNull()
    expect(sogliaRaggiunta(Number.POSITIVE_INFINITY)).toBeNull()
    expect(sogliaRaggiunta(giorniResidui('2026-02-30', '2026-08-11'))).toBeNull()
  })

  it('anche un OGGI illeggibile produce silenzio, non un allarme', () => {
    expect(giorniResidui('2026-08-11', 'boh')).toBeNaN()
    expect(sogliaRaggiunta(giorniResidui('2026-08-11', 'boh'))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · l’idempotenza: una soglia, un avviso', () => {
  const ADESSO = '2026-08-11T05:47:00Z'

  it('mai avvisato → si avvisa', () => {
    expect(vaAvvisato(90, null, null, ADESSO)).toBe(true)
    expect(vaAvvisato(90, undefined, undefined, ADESSO)).toBe(true)
    expect(vaAvvisato(SOGLIA_SCADUTO, null, null, ADESSO)).toBe(true)
  })

  it('la stessa soglia NON si rimanda, nemmeno a mesi di distanza', () => {
    // È il difetto n. 4 della testata: senza questa regola l'avviso «mancano 30
    // giorni» ripartirebbe ogni notte per trenta notti.
    expect(vaAvvisato(30, 30, '2026-08-10T05:47:00Z', ADESSO)).toBe(false)
    expect(vaAvvisato(30, 30, '2026-06-01T05:47:00Z', ADESSO)).toBe(false)
    expect(vaAvvisato(90, 90, null, ADESSO)).toBe(false)
  })

  it('la soglia SCENDE → si avvisa (90, poi 60, poi 30, poi 7, poi scaduto)', () => {
    expect(vaAvvisato(60, 90, '2026-06-01T05:47:00Z', ADESSO)).toBe(true)
    expect(vaAvvisato(30, 60, '2026-07-01T05:47:00Z', ADESSO)).toBe(true)
    expect(vaAvvisato(7, 30, '2026-08-01T05:47:00Z', ADESSO)).toBe(true)
    expect(vaAvvisato(SOGLIA_SCADUTO, 7, '2026-08-09T05:47:00Z', ADESSO)).toBe(true)
  })

  it('una soglia che SALE non riapre nulla: non si torna a dire «mancano 90 giorni»', () => {
    // Nessun percorso applicativo lo produce (il trigger azzera invece di
    // risalire), quindi è uno stato incoerente: e su uno stato incoerente si tace,
    // perché ripetere un preavviso più largo di quello già dato disinforma.
    expect(vaAvvisato(90, 30, '2026-08-01T05:47:00Z', ADESSO)).toBe(false)
    expect(vaAvvisato(60, SOGLIA_SCADUTO, '2026-08-01T05:47:00Z', ADESSO)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · il risollecito dello SCADUTO', () => {
  const RISOLLECITO = PERSONALE_LIMITI.giorniRisollecitoScaduto

  it(`riparte SOLO dopo ${RISOLLECITO} giorni, mai prima`, () => {
    const adesso = '2026-08-11T05:47:00Z'
    for (let g = 0; g < RISOLLECITO; g++) {
      const ultimo = `${aggiungiGiorni('2026-08-11', -g)}T05:47:00Z`
      expect(
        vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, ultimo, adesso),
        `a ${g} giorni dall'ultimo invio non si deve risollecitare`,
      ).toBe(false)
    }
    const alTermine = `${aggiungiGiorni('2026-08-11', -RISOLLECITO)}T05:47:00Z`
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, alTermine, adesso)).toBe(true)
    const oltre = `${aggiungiGiorni('2026-08-11', -RISOLLECITO - 40)}T05:47:00Z`
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, oltre, adesso)).toBe(true)
  })

  it('🔴 il jitter del cron NON allontana il risollecito di un giorno', () => {
    // Il difetto n. 5 della testata, con i numeri veri: il cron parte alle 05:47,
    // il giro precedente ha scritto `scadenza_avvisata_il` a 05:47:59 e questo
    // gira alle 05:47:01. Sette giorni MENO 58 secondi: un confronto sui
    // millisecondi risponde «non ancora», il risollecito slitta a domani, e da
    // domani in poi la cadenza è di otto giorni.
    expect(
      vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, '2026-08-04T05:47:59Z', '2026-08-11T05:47:01Z'),
    ).toBe(true)
  })

  it('🔴 il settimo giorno è quello ITALIANO, non quello UTC', () => {
    // `2026-08-03T23:30:00Z` a Roma è già il 4 agosto (01:30). Contando i giorni
    // con `iso.slice(0, 10)` — cioè in UTC — verrebbero fuori 7 giorni e il
    // risollecito partirebbe con un giorno d'anticipo. In Europe/Rome ne sono
    // passati 6, e non si manda niente.
    expect(
      vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, '2026-08-03T23:30:00Z', '2026-08-10T05:47:00Z'),
    ).toBe(false)
    expect(
      vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, '2026-08-03T23:30:00Z', '2026-08-11T05:47:00Z'),
    ).toBe(true)
  })

  it('un istante di invio assente o illeggibile fa risollecitare, non tacere', () => {
    // Combinazione che nessun percorso applicativo produce (le due colonne si
    // scrivono e si azzerano insieme): esiste solo dopo una scrittura fatta a mano
    // in SQL. Fra «tacere per sempre su un documento scaduto» e «un avviso in
    // più» si sceglie l'avviso — che si autoripara al primo giro, perché subito
    // dopo l'invio il campo viene riscritto.
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, null, '2026-08-11T05:47:00Z')).toBe(true)
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, 'boh', '2026-08-11T05:47:00Z')).toBe(true)
  })

  it('un ADESSO illeggibile non produce una raffica: si tace', () => {
    // Il verso opposto del caso qui sopra, e per una ragione diversa: «non so che
    // giorno è» è un guasto del chiamante, e un guasto del chiamante non deve
    // poter spedire email a tutta la sede.
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, '2026-01-01T05:47:00Z', 'boh')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · il tetto dei risolleciti via EMAIL', () => {
  const RISOLLECITO = PERSONALE_LIMITI.giorniRisollecitoScaduto
  const OGGI = '2026-08-11'
  /** Quanti giorni di SERIE (non di scadenza) stanno oltre il tetto. */
  const OLTRE = (MAX_RISOLLECITI_EMAIL + 1) * RISOLLECITO

  /**
   * Da quanti giorni è scaduto un documento il giorno in cui scatta il
   * risollecito n. `n`.
   *
   * ⚠️ `+1`, e non è un dettaglio: il primo giorno in cui un documento è SCADUTO
   * è quello dopo la scadenza (`sogliaRaggiunta` risponde `0` da `giorni < 0`,
   * perché un documento d'identità è valido fino al giorno di scadenza compreso).
   * La serie parte da lì: n. 0 a `scadenza + 1`, poi uno ogni `RISOLLECITO`
   * giorni. Un test che contasse da `scadenza` misurerebbe giorni in cui il cron
   * non manda niente — cioè un confine che nella realtà non esiste.
   */
  const giornoDelRisollecito = (n: number) => 1 + n * RISOLLECITO

  /**
   * Una riga che INVECCHIA DENTRO IL SISTEMA: nata molto prima della scadenza.
   * È il caso per cui «scaduta da n·7 giorni» e «sollecitata n volte» coincidono
   * — e per cui il vecchio conto sembrava giusto.
   */
  const anziana = (giorniDaScadenza: number) => ({
    scadenzaYMD: giorno(OGGI, -giorniDaScadenza),
    creataISO: `${giorno(OGGI, -giorniDaScadenza - 400)}T09:00:00Z`,
  })

  it('un PREAVVISO non ha tetto: si manda una volta sola per definizione', () => {
    // La monotonia di `vaAvvisato` garantisce già l'unicità di 90/60/30/7: non
    // c'è nessuna ripetizione da limitare, e mettere un tetto qui significherebbe
    // poter perdere l'unico avviso che quella soglia manda.
    for (const soglia of SOGLIE) {
      for (const ultimaSoglia of [null, soglia, 0]) {
        expect(
          emailRisollecitoDovuta({ soglia, ultimaSoglia, ...anziana(-soglia), oggiYMD: OGGI }),
          `il preavviso ${soglia} deve mandare l'email qualunque sia lo stato precedente`,
        ).toBe(true)
      }
    }
  })

  it(`lo SCADUTO manda posta fino al risollecito n. ${MAX_RISOLLECITI_EMAIL}, poi basta`, () => {
    // Il confine, giorno per giorno, su una riga ANZIANA: `n * 7` giorni oltre la
    // scadenza = il risollecito n. `n`. Fin dentro il tetto la posta parte; il
    // primo giorno del risollecito successivo non parte più.
    // ⚠️ `ultimaSoglia: 0` in tutte le righe, e adesso è un'ipotesi DICHIARATA e
    // non più nascosta: qui si misura il tetto sui RISOLLECITI, cioè su chi lo
    // scaduto se l'è già sentito dire. Il primo annuncio ha il suo test più sotto.
    const posta = (giorniDaScadenza: number) =>
      emailRisollecitoDovuta({
        soglia: SOGLIA_SCADUTO,
        ultimaSoglia: SOGLIA_SCADUTO,
        ...anziana(giorniDaScadenza),
        oggiYMD: OGGI,
      })
    for (let n = 0; n <= MAX_RISOLLECITI_EMAIL; n++) {
      expect(
        posta(giornoDelRisollecito(n)),
        `il risollecito n. ${n} è dentro il tetto e deve mandare ancora l'email`,
      ).toBe(true)
    }
    // Il giorno PRIMA del risollecito di troppo è ancora dentro: il confine è
    // dove il conto cambia, non dove fa comodo.
    expect(posta(giornoDelRisollecito(MAX_RISOLLECITI_EMAIL + 1) - 1)).toBe(true)
    expect(
      posta(giornoDelRisollecito(MAX_RISOLLECITI_EMAIL + 1)),
      `oltre ${OLTRE} giorni di serie l'email non deve più ripartire`,
    ).toBe(false)
    expect(posta(3650)).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // IL DIFETTO N. 7 DELLA TESTATA: il tetto ancorato all'ANZIANITÀ della scadenza
  // invece che ai solleciti mandati davvero.
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴 chi ENTRA con il documento già scaduto riceve la PRIMA email: il tetto non nasce esaurito', () => {
    // ─── IL CASO REALE, ed è quello che il modulo dichiara di servire ────────
    //
    // `personale-template.ts:210-212` ammette di proposito una data di scadenza
    // già passata, perché «chi ha il documento scaduto è esattamente la persona
    // per cui questo modulo esiste». Una dipendente storica inserita oggi con la
    // carta d'identità scaduta da 215 giorni: nessuno le ha mai mandato niente
    // (`ultimaSoglia: null`), eppure il conto derivato dalla sola scadenza diceva
    // «31 solleciti» e sopprimeva la posta — a lei E alla segreteria, che senza
    // documento valido non può eseguire UNILAV, libro unico e denunce INPS/INAIL.
    // Restava la sola notifica in-app, cioè il canale che nessuno presidia.
    //
    // La misura del confine sul codice precedente: 62 giorni → email, 63 → niente,
    // ANCHE alla primissima volta.
    for (const giorniScaduta of [1, 62, 63, 215, 3650]) {
      expect(
        emailRisollecitoDovuta({
          soglia: SOGLIA_SCADUTO,
          ultimaSoglia: null,
          scadenzaYMD: giorno(OGGI, -giorniScaduta),
          // La riga è NATA OGGI: è il fatto che il vecchio conto ignorava.
          creataISO: `${OGGI}T09:12:00Z`,
          oggiYMD: OGGI,
        }),
        `documento scaduto da ${giorniScaduta} giorni ma MAI annunciato: la prima email è dovuta`,
      ).toBe(true)
    }
  })

  it('🔴 il primo annuncio è dovuto anche arrivando da un preavviso (60/30/7 → scaduto)', () => {
    // L'altra porta dello stesso difetto: qui `ultimaSoglia` non è `null` ma un
    // preavviso. Il passaggio «7 → scaduto» è il PRIMO annuncio dello scaduto, e
    // il tetto dei risolleciti non c'entra niente con lui.
    for (const preavviso of SOGLIE) {
      expect(
        emailRisollecitoDovuta({
          soglia: SOGLIA_SCADUTO,
          ultimaSoglia: preavviso,
          ...anziana(OLTRE + 100),
          oggiYMD: OGGI,
        }),
        `da preavviso ${preavviso} allo scaduto: è il primo annuncio, l'email parte`,
      ).toBe(true)
    }
  })

  it('🔴 la serie non comincia prima che la riga esista: i risolleciti si contano da lì', () => {
    // Il seguito del caso qui sopra, ed è la parte che una sola guardia sul primo
    // annuncio non coprirebbe: dopo il primo annuncio lo stato è `0`, e se il
    // conto ripartisse dalla scadenza il SECONDO invio sarebbe già oltre il tetto
    // — una email sola, e mai più, su una non conformità aperta.
    //
    // Riga nata 30 giorni fa con un documento scaduto da 215: al 30° giorno di
    // vita siamo al risollecito n. 4, non al n. 30.
    expect(numeroRisollecito(giorno(OGGI, -215), `${giorno(OGGI, -30)}T09:00:00Z`, OGGI)).toBe(4)
    expect(
      emailRisollecitoDovuta({
        soglia: SOGLIA_SCADUTO,
        ultimaSoglia: SOGLIA_SCADUTO,
        scadenzaYMD: giorno(OGGI, -215),
        creataISO: `${giorno(OGGI, -30)}T09:00:00Z`,
        oggiYMD: OGGI,
      }),
    ).toBe(true)
    // …e il tetto morde comunque, quando i solleciti sono stati mandati davvero.
    expect(
      emailRisollecitoDovuta({
        soglia: SOGLIA_SCADUTO,
        ultimaSoglia: SOGLIA_SCADUTO,
        scadenzaYMD: giorno(OGGI, -215),
        creataISO: `${giorno(OGGI, -OLTRE)}T09:00:00Z`,
        oggiYMD: OGGI,
      }),
      'una riga vissuta abbastanza a lungo esaurisce il tetto come tutte le altre',
    ).toBe(false)
  })

  it('🔴 il giorno di nascita della riga è quello ITALIANO, non quello UTC', () => {
    // Stessa disciplina di `vaAvvisato`, e qui il confine è scelto perché
    // DISCRIMINA: `…T23:30:00Z` del giorno OGGI-7 a Roma è già OGGI-6 (01:30).
    //   · giorno italiano → 6 giorni di serie → risollecito n. 0 (ancora il primo
    //     annuncio: nessun sollecito consumato);
    //   · giorno UTC      → 7 giorni        → risollecito n. 1.
    // Un giorno di scarto qui non sposta una data di un giorno: sposta di UNA
    // SETTIMANA il momento in cui la posta alla segreteria si ferma, ed è un
    // errore che si accumula a ogni giro.
    const scadenzaVecchia = giorno(OGGI, -900)
    expect(numeroRisollecito(scadenzaVecchia, `${giorno(OGGI, -7)}T23:30:00Z`, OGGI)).toBe(0)
    // Il controllo positivo: 24 ore prima (stessa ora) il giorno italiano è OGGI-7.
    expect(numeroRisollecito(scadenzaVecchia, `${giorno(OGGI, -8)}T23:30:00Z`, OGGI)).toBe(1)
  })

  it('il tetto copre almeno due mesi: il tempo di un appuntamento in Comune', () => {
    // Il numero non è arbitrario e il test lo dichiara: se qualcuno lo abbassasse
    // a due o tre, il tetto morderebbe sul caso NORMALE — una persona che sta
    // aspettando l'appuntamento per la carta d'identità — e la segreteria
    // smetterebbe di ricevere posta proprio mentre serve.
    expect(MAX_RISOLLECITI_EMAIL * RISOLLECITO).toBeGreaterThanOrEqual(56)
  })

  it('una data illeggibile manda l’email, non inaugura un silenzio', () => {
    // Non dovrebbe arrivarci — `sogliaRaggiunta(NaN)` è `null` e la riga viene
    // saltata prima — ma il verso giusto su un allarme è l'avviso in più.
    for (const scadenzaYMD of ['2026-02-30', 'boh', '']) {
      expect(
        emailRisollecitoDovuta({
          soglia: SOGLIA_SCADUTO,
          ultimaSoglia: SOGLIA_SCADUTO,
          scadenzaYMD,
          creataISO: `${OGGI}T09:00:00Z`,
          oggiYMD: OGGI,
        }),
        `scadenza «${scadenzaYMD}»: si manda l'email, non si tace`,
      ).toBe(true)
    }
    // E un `creata_il` illeggibile o assente non deve alterare il conto vecchio:
    // si torna alla sola scadenza, che è il comportamento conservativo.
    expect(numeroRisollecito(giorno(OGGI, -70), null, OGGI)).toBe(9)
    expect(numeroRisollecito(giorno(OGGI, -70), 'boh', OGGI)).toBe(9)
    expect(numeroRisollecito(giorno(OGGI, -70), undefined, OGGI)).toBe(9)
  })

  it('🔴 il tetto NON spegne l’avviso: `vaAvvisato` continua a dire di sì', () => {
    // È la differenza fra «l'email si ferma» e «l'allarme si spegne da solo»,
    // che è il difetto opposto. Il risollecito resta dovuto — notifica in-app, e
    // quella persona continua a contare in `n_scaduti` nelle notti in cui il
    // risollecito scatta — e solo il canale di posta si ferma: le due funzioni
    // rispondono cose diverse sulla stessa riga, ed è voluto.
    const ultimo = `${giorno(OGGI, -RISOLLECITO)}T05:47:00Z`
    expect(vaAvvisato(SOGLIA_SCADUTO, SOGLIA_SCADUTO, ultimo, `${OGGI}T05:47:00Z`)).toBe(true)
    expect(
      emailRisollecitoDovuta({
        soglia: SOGLIA_SCADUTO,
        ultimaSoglia: SOGLIA_SCADUTO,
        ...anziana(giornoDelRisollecito(MAX_RISOLLECITI_EMAIL + 1)),
        oggiYMD: OGGI,
      }),
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · le soglie non sono ribattute qui', () => {
  it('SOGLIE viene da PERSONALE_LIMITI, che è il posto che le PROMETTE', () => {
    // Due elenchi indipendenti per la stessa cosa divergono al primo cambio, e a
    // divergere sarebbe la frequenza con cui una persona viene avvisata di un
    // obbligo che la riguarda.
    expect([...SOGLIE]).toEqual(PERSONALE_LIMITI.soglieAvviso.filter((s) => s > 0))
    expect(SOGLIA_MAX).toBe(Math.max(...PERSONALE_LIMITI.soglieAvviso))
    expect(PERSONALE_LIMITI.soglieAvviso).toContain(SOGLIA_SCADUTO)
  })

  it('ogni soglia dichiarata è raggiungibile: nessuna resta lettera morta', () => {
    // Un preavviso presente nell'elenco ma che `sogliaRaggiunta` non restituisce
    // mai sarebbe una promessa scritta e mai mantenuta — e non lo direbbe nessuno.
    for (const soglia of SOGLIE) {
      expect(sogliaRaggiunta(soglia), `la soglia ${soglia} non è raggiungibile`).toBe(soglia)
    }
    expect(sogliaRaggiunta(-1)).toBe(SOGLIA_SCADUTO)
  })

  it('ogni soglia dichiarata è AMMESSA ANCHE DAL DDL: le due liste non divergono', () => {
    // ─── IL DIFETTO CHE QUESTA ASSERZIONE IMPEDISCE ─────────────────────────
    //
    // Il valore annunciato non resta in memoria: la route lo scrive in
    // `anagrafica_personale.scadenza_soglia_avvisata`, che è
    // `smallint check (… in (90,60,30,7,0))`. Le due liste — quella di
    // `PERSONALE_LIMITI` e quella del CHECK — descrivono la stessa cosa da due
    // file diversi, e finché nessuno le lega possono divergere in silenzio.
    //
    // Aggiungendo un preavviso a 120 giorni SOLO in `PERSONALE_LIMITI`, la
    // finestra si allarga e gli avvisi partono (la parte visibile funziona),
    // l'UPDATE viola il vincolo con `23514`, lo stato non viene mai scritto e
    // `vaAvvisato(120, null, …)` risponde `true` ogni notte: raffica quotidiana
    // in-app all'interessata e alla segreteria, più un 500 a ogni giro.
    //
    // ─── PERCHÉ SI LEGGE IL DDL E NON SI RIBATTE `[90,60,30,7,0]` QUI ───────
    //
    // Perché una terza copia della stessa lista avrebbe lo stesso difetto delle
    // prime due: sarebbe verde anche dopo che qualcuno allarga il CHECK e si
    // dimentica di aggiornarla. Qui si legge la migrazione APPLICATA, che è la
    // sola descrizione autorevole di ciò che il database accetta davvero.
    const ddl = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260811205643_anagrafica_personale.sql'),
      'utf8',
    )
    const clausola = /scadenza_soglia_avvisata\s+in\s*\(([^)]*)\)/.exec(ddl)
    expect(
      clausola,
      'il CHECK su `scadenza_soglia_avvisata` non si trova più nella migrazione: ' +
        'se è stato spostato in una migrazione successiva, questo lock va puntato là — ' +
        'non cancellato, perché è l’unica cosa che lega le soglie al vincolo del database.',
    ).not.toBeNull()

    const ammesse = clausola![1].split(',').map((v) => Number(v.trim()))
    for (const soglia of PERSONALE_LIMITI.soglieAvviso) {
      expect(
        ammesse,
        `la soglia ${soglia} è dichiarata in PERSONALE_LIMITI ma il CHECK del database non l’accetta: ` +
          'l’UPDATE del cron fallirà con 23514, lo stato non verrà mai scritto e l’avviso ripartirà ' +
          'OGNI NOTTE. Serve una migrazione che allarghi ' +
          '`anagrafica_personale.scadenza_soglia_avvisata`.',
      ).toContain(soglia)
    }
    // E il verso opposto: un valore ammesso dal DDL e non più dichiarato qui è
    // una soglia che il database si aspetta e che nessuno manderà mai. Non è un
    // guasto, ma è uno scarto fra due file che vanno letti insieme, e va visto
    // adesso invece che da chi indagherà su un vincolo senza spiegazione.
    expect(
      [...ammesse].sort((a, b) => a - b),
      'il CHECK del database ammette valori che PERSONALE_LIMITI non dichiara più (o viceversa)',
    ).toEqual([...PERSONALE_LIMITI.soglieAvviso].sort((a, b) => a - b))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · lock di forma: «oggi» è sempre iniettato', () => {
  const sorgente = fs.readFileSync(SORGENTE, 'utf8')
  const { struttura } = mascheraSorgente(sorgente)

  it('nessun `new Date()` senza argomenti e nessun `Date.now()` nel modulo', () => {
    // È la disciplina che rende deterministici tutti i test qui sopra: con
    // l'orologio letto QUI DENTRO, «il 90 scatta a 90 e non a 89» non sarebbe
    // un'asserzione su due stringhe ma una misura dell'istante in cui gira la
    // suite — e i confini tornerebbero a essere non collaudabili.
    // `new Date(iso)` CON argomento resta lecito: converte, non legge l'orologio.
    const colpevoli: string[] = []
    for (const re of [/new\s+Date\s*\(\s*\)/g, /\bDate\.now\s*\(/g]) {
      let m: RegExpExecArray | null
      while ((m = re.exec(struttura))) colpevoli.push(`riga ${riga(sorgente, m.index)}: ${m[0]}`)
    }
    expect(
      colpevoli,
      'src/lib/anagrafica/scadenze.ts legge l’orologio invece di riceverlo come parametro: ' +
        'è la stessa disciplina di src/lib/pagamenti/aging.ts, e senza di essa i confini delle ' +
        'soglie non sono collaudabili.\n' + colpevoli.join('\n'),
    ).toEqual([])
  })

  it('nessuna aritmetica in millisecondi sulle DATE', () => {
    // `86_400_000` in questo modulo significherebbe che qualcuno è tornato a
    // sottrarre `Date`: è il difetto n. 2 della testata, e non lo prenderebbe
    // nessuna delle asserzioni sul comportamento se il caso di prova cadesse
    // fuori dai giorni di cambio dell'ora.
    expect(/86[_.]?400[_.]?000/.test(struttura)).toBe(false)
    expect(/getTime\s*\(\s*\)\s*-/.test(struttura)).toBe(false)
  })
})
