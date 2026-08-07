import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RADICE = process.cwd()
const INFORMATIVA = join(RADICE, 'src/app/privacy/page.tsx')
const ROUTE_RETENTION = join(RADICE, 'src/app/api/gdpr/retention-iscrizioni/route.ts')
const OBLIO = join(RADICE, 'src/lib/gdpr/esegui.ts')
const MIGRAZIONI = join(RADICE, 'supabase/migrations')

const informativa = readFileSync(INFORMATIVA, 'utf8')
const route = readFileSync(ROUTE_RETENTION, 'utf8')
const oblio = readFileSync(OBLIO, 'utf8')

/** La sezione dell'informativa che questo file sorveglia, dal titolo in poi. */
const sezioneConservazione = informativa.slice(informativa.indexOf('Conservazione dei dati'))

/**
 * In un testo legale il numero si scrive in lettere: si accetta la cifra o la
 * parola, perché è la COERENZA a essere sorvegliata, non la tipografia.
 * Una mappa sola per tutte le prove di questo file — due copie diverse degli
 * stessi numeri sono il difetto che il file esiste per impedire.
 */
const MESI_IN_LETTERE: Record<number, string> = {
  6: 'sei', 12: 'dodici', 18: 'diciotto', 24: 'ventiquattro', 36: 'trentasei', 48: 'quarantotto',
}

/** L'informativa dichiara `mesi` (in cifre o in lettere) dentro `testo`? */
function dichiaraIMesi(testo: string, mesi: number): boolean {
  const parola = MESI_IN_LETTERE[mesi]
  return (
    new RegExp(`${mesi}\\s*mesi`, 'i').test(testo) ||
    (parola !== undefined && new RegExp(`${parola}\\s*mesi`, 'i').test(testo))
  )
}

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
    const sezione = sezioneConservazione
    expect(
      /pre-iscrizione non accolte|non accolte/i.test(sezione),
      'la sezione «Conservazione dei dati» non dice per quanto si conservano le domande di chi ' +
        'si pre-iscrive e non viene accolto — mentre il codice le cancella a scadenza',
    ).toBe(true)
  })

  it('e dichiara LO STESSO numero di mesi che il codice applica', () => {
    const mesi = Number(route.match(/const MESI_CONSERVAZIONE = (\d+)/)![1])
    const parola = MESI_IN_LETTERE[mesi]
    expect(
      dichiaraIMesi(sezioneConservazione, mesi),
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

// =============================================================================
// IL SECONDO CAMPO CHE L'INFORMATIVA PROMETTE E NESSUNO CANCELLAVA:
// il MOTIVO DELL'ASSENZA. (rilievo privacy del collaudo, 2026-08-07)
//
// ─── LA STORIA ──────────────────────────────────────────────────────────────
//
// `presenze.giustificazione_testo` è testo libero, e il segnaposto del modulo
// genitore chiede testualmente un sintomo: «Es. febbre, visita medica, motivi
// familiari…». Il campo esisteva dal baseline ma il canale era morto — misurato
// in produzione: 49 righe di presenza, ZERO scritte da un genitore. Finché
// nessuno lo riempiva, la promessa dell'informativa non era smentita dai fatti.
//
// Il ciclo che rimette in vita «Comunica un'assenza» apre quel canale su tutti e
// tre i gradi. Da quel momento l'informativa dichiarava, per i dati relativi
// alla salute, «non oltre la durata dell'iscrizione» — e non esisteva NIENTE che
// applicasse quel termine: nessuno dei dieci job in `cron.schedule` toccava
// `presenze`, e il flusso di oblio su richiesta non ci arrivava (16 tabelle,
// `presenze` non c'era). Dopo una cancellazione chiesta da una famiglia il nome
// del bambino diventava un segnaposto e il motivo della sua assenza restava
// leggibile per sempre.
//
// ─── PERCHÉ UN LOCK, E PERCHÉ DI QUESTA FORMA ───────────────────────────────
//
// Perché il difetto non è la riga di SQL mancante: è che la promessa e il
// meccanismo vivono in due file che nessuno confronta. Ed è il gemello esatto
// del difetto già chiuso qui sopra per le domande non accolte, arrivato tre
// giorni dopo su un'altra colonna.
//
// Il lock guarda TRE cose, e non le parole di un commento:
//  · che il lavoro di scadenza esista, dichiari i suoi mesi e sia SCHEDULATO
//    (una funzione scritta e mai chiamata è un difetto che questo repo ha già
//    pagato: `obliaFotoNewsAlunno`, testata per mesi senza un chiamante);
//  · che l'informativa dichiari LO STESSO numero;
//  · che l'oblio SU RICHIESTA raggiunga le stesse due colonne — la scadenza
//    automatica non sostituisce l'art. 17, e viceversa.
// =============================================================================

const SQL_MIGRAZIONI = readdirSync(MIGRAZIONI)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRAZIONI, f), 'utf8') }))

const FUNZIONE_SCADENZA = 'presenze_giustificazioni_retention_tick'
const JOB_SCADENZA = 'presenze-giustificazioni-retention'

/** L'ULTIMA migrazione che (ri)definisce la funzione: è quella che vale. */
const definizioneScadenza = [...SQL_MIGRAZIONI]
  .reverse()
  .find(({ sql }) =>
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${FUNZIONE_SCADENZA}\\s*\\(`, 'i').test(sql),
  )

/** Le due colonne di testo libero di `presenze`, e chi ce le scrive. */
const COLONNE_TESTO_LIBERO: Record<string, string> = {
  giustificazione_testo: 'il motivo che il GENITORE scrive comunicando o giustificando un’assenza',
  note_appello: 'la nota che il DOCENTE scrive facendo l’appello',
}

describe('lock · il motivo dell’assenza scade e si dimentica', () => {
  it('esiste un lavoro di scadenza, e dichiara i suoi mesi (sanity)', () => {
    // Se questa cade, tutte le prove qui sotto girerebbero sul vuoto.
    expect(
      definizioneScadenza,
      `Nessuna migrazione definisce \`public.${FUNZIONE_SCADENZA}()\`. L'informativa promette che ` +
        `i dati relativi alla salute non si conservano oltre la durata dell'iscrizione, e ` +
        `\`presenze.giustificazione_testo\` è testo libero che il modulo del genitore chiede di ` +
        `riempire con un sintomo: senza un lavoro di scadenza quella promessa non è applicata da nulla.`,
    ).toBeTruthy()
    const m = definizioneScadenza!.sql.match(/v_mesi\s+constant\s+int\s*:=\s*(\d+)/i)
    expect(
      m,
      `\`${FUNZIONE_SCADENZA}\` non dichiara \`v_mesi constant int := N\`: il termine deve essere ` +
        `UN numero, in un punto solo, leggibile da qui e confrontabile con l'informativa.`,
    ).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
  })

  it('il lavoro azzera ENTRAMBE le colonne di testo libero di `presenze`', () => {
    const sql = definizioneScadenza!.sql
    for (const [colonna, chi] of Object.entries(COLONNE_TESTO_LIBERO)) {
      expect(
        new RegExp(`${colonna}\\s*=\\s*NULL`, 'i').test(sql),
        `Il lavoro di scadenza non azzera \`presenze.${colonna}\` — ${chi}. Le due colonne hanno la ` +
          `stessa natura e lo stesso destinatario: coprirne una sola lascia il difetto per metà.`,
      ).toBe(true)
    }
  })

  it('e il lavoro è SCHEDULATO (una funzione mai chiamata non conserva niente)', () => {
    const schedulato = SQL_MIGRAZIONI.some(
      ({ sql }) =>
        sql.includes(`'${JOB_SCADENZA}'`) &&
        new RegExp(`cron\\.schedule\\s*\\(`, 'i').test(sql),
    )
    expect(
      schedulato,
      `Nessun \`cron.schedule('${JOB_SCADENZA}', …)\` in supabase/migrations/. La funzione ` +
        `esisterebbe e non girerebbe mai: è esattamente la forma del difetto di ` +
        `\`obliaFotoNewsAlunno\` — scritta, testata e senza chiamante.`,
    ).toBe(true)
  })

  it('l’informativa parla del MOTIVO DELL’ASSENZA e dichiara lo stesso numero di mesi', () => {
    const mesi = Number(definizioneScadenza!.sql.match(/v_mesi\s+constant\s+int\s*:=\s*(\d+)/i)![1])
    expect(
      /motivo dell.{0,8}assenza/i.test(sezioneConservazione),
      'la sezione «Conservazione dei dati» non nomina il motivo dell’assenza. La voce generica ' +
        '«dati relativi alla salute» non basta più: da questo ciclo la scuola RACCOGLIE quel testo ' +
        'da tutte le famiglie, e il termine applicato dal codice va dichiarato a chi lo scrive.',
    ).toBe(true)
    const parola = MESI_IN_LETTERE[mesi]
    expect(
      dichiaraIMesi(sezioneConservazione, mesi),
      `Il lavoro \`${JOB_SCADENZA}\` cancella il motivo dell'assenza dopo ${mesi} mesi, e ` +
        `l'informativa non dichiara quel termine. È la dichiarazione su cui la famiglia ha ` +
        `prestato il consenso (art. 13 §2 lett. a GDPR), non una nota interna.` +
        (parola === undefined
          ? ` (Nessuna forma in lettere nota per ${mesi}: aggiungila alla mappa di questo lock.)`
          : ''),
    ).toBe(true)
  })

  it('l’oblio SU RICHIESTA raggiunge le stesse due colonne (art. 17, che non aspetta la scadenza)', () => {
    expect(
      /\.from\('presenze'\)/.test(oblio),
      '`src/lib/gdpr/esegui.ts` non tocca `presenze`: dopo una cancellazione chiesta dalla ' +
        'famiglia il nome del bambino diventa un segnaposto e il motivo della sua assenza resta ' +
        'leggibile, accanto a un `alunno_id` invariato.',
    ).toBe(true)
    for (const [colonna, chi] of Object.entries(COLONNE_TESTO_LIBERO)) {
      expect(
        new RegExp(`${colonna}:\\s*null`, 'i').test(oblio),
        `L'oblio non azzera \`presenze.${colonna}\` — ${chi}.`,
      ).toBe(true)
    }
  })
})
