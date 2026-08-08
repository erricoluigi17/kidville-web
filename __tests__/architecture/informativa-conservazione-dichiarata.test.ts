import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JOB_CRON, JOB_CRON_NON_SORVEGLIATI } from '@/lib/health/controlli'

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

// =============================================================================
// LO SPAZIO IN CUI IL DIFETTO È NATO: LA PAROLA «AUTOMATICAMENTE».
// (rilievo bloccante di DUE tester indipendenti — backend e privacy, 2026-08-07)
//
// ─── IL FATTO ───────────────────────────────────────────────────────────────
//
// Le prove qui sopra erano TUTTE VERDI mentre l'informativa pubblicata prometteva
// alle famiglie che il motivo dell'assenza «è cancellato automaticamente» dopo
// dodici mesi, e in produzione quel meccanismo NON ESISTEVA: la migrazione che
// crea la funzione e il lavoro notturno è stata scritta e non applicata.
//
// Misurato in produzione il 2026-08-07, in sola lettura:
//   SELECT jobname FROM cron.job ORDER BY jobname;
//     → app-log-bonifica-pii, app-log-purge, audit-docente-retention,
//       consensi-retention, fatture-sdi-sync, iscrizioni-retention,
//       iscrizioni-retention-esito, iscrizioni-sanitari, mensa-check-allergie,
//       news-digest, news-retention, news-tick, notifiche-dispatch,
//       notifiche-promemoria, pagamenti-solleciti-run, tetto-frequenza-pulizia
//     → 'presenze-giustificazioni-retention' NON C'È.
//   SELECT proname FROM pg_proc … WHERE proname LIKE '%retention%';
//     → audit_docente_retention_tick, iscrizioni_retention_http,
//       iscrizioni_retention_sorveglia, iscrizioni_retention_tick
//     → 'presenze_giustificazioni_retention_tick' NON C'È (PGRST202 alla chiamata).
//
// ─── PERCHÉ LE PROVE QUI SOPRA NON BASTAVANO ────────────────────────────────
//
// Perché confrontano DUE FILE fra loro: il numero scritto nel SQL e il numero
// scritto nell'informativa. Un file SQL che nessuno ha applicato è, per loro,
// indistinguibile da un lavoro che gira ogni notte. Il gate era verde sul vuoto.
//
// È la lezione che questo repo ha già pagato, scritta nel suo stesso `CLAUDE.md`:
// «un documento che descrive una protezione che non c'è più è peggio di nessun
// documento». Qui è la stessa cosa al contrario — una protezione che non c'è
// ANCORA — e il documento è quello che leggono le famiglie di 32 bambini, su un
// dato relativo alla salute di un minore (art. 9 GDPR).
//
// ─── COSA SORVEGLIA QUESTO BLOCCO ───────────────────────────────────────────
//
// La regola è una sola: **l'informativa può promettere un automatismo soltanto se
// l'automa esiste.** Da qui:
//  1. ogni voce che dice «cancellati automaticamente» dev'essere dichiarata nella
//     mappa qui sotto, con il nome del lavoro che la esegue — nessuno può
//     aggiungere la parola senza dire chi la mantiene;
//  2. quel lavoro dev'essere schedulato in una migrazione con QUEL nome;
//  3. la migrazione che lo installa non dev'essere di quelle marcate «NON
//     APPLICATA»: un lavoro che vive solo nel file SQL non cancella niente.
//
// L'impegno dei mesi resta comunque dichiarato e sorvegliato (le prove qui
// sopra): togliere la parola «automaticamente» non accorcia né allunga il
// termine, toglie l'affermazione che a rispettarlo sia una macchina.
//
// ─── COME SI TORNA A POTER SCRIVERE «AUTOMATICAMENTE» ───────────────────────
//
// Applicata la migrazione (`mcp__supabase__apply_migration` + `get_advisors`),
// si attesta il fatto nella testata del file SQL con una riga
// «APPLICATA il AAAA-MM-GG» — che è ciò che questo lock legge — e si rimette la
// parola nella voce dell'informativa. Una riga in più nel SQL, una parola in più
// nel testo: il paragrafo non va riscritto.
// La prova che conta resta però la terza, e non la sa nessun test:
//   SELECT creato_il FROM public.app_log
//    WHERE fingerprint = 'cron:presenze-giustificazioni-retention'
//    ORDER BY creato_il DESC LIMIT 3;   -- la notte dopo
// =============================================================================

// =============================================================================
// E CHI GUARDA CHE IL LAVORO GIRI? (rilievo Q3, quarto collaudo)
//
// ─── IL FATTO ───────────────────────────────────────────────────────────────
//
// La migrazione del job gemello scriveva, per iscritto, che il battito era stato
// messo su `evento='cron'` apposta perché «`controlloBattitoCron` cerca i battiti
// con `.eq('evento','cron')` … un lavoro che smette di girare non se ne accorge
// nessuno». La correzione era giusta a metà e non funzionava, per due ragioni
// indipendenti, entrambe misurate in produzione in sola lettura:
//
//   select fingerprint, evento, contesto ? 'campi' as ha_campi from app_log
//    where fingerprint like 'cron:%retention';
//     → cron:notifiche-retention                | cron | ha_campi = FALSE
//     → cron:presenze-giustificazioni-retention | gdpr | ha_campi = FALSE
//
//  1. `controlloBattitoCron` scarta le righe senza `contesto.campi.esito === 'ok'`
//     (controlli.ts): le due funzioni SQL scrivono un `contesto` PIATTO, perché
//     nascono da un `jsonb_build_object` nella migrazione, mentre `logEvento`
//     annida tutto sotto `campi`. Due produttori dello stesso formato, e solo uno
//     è quello che il consumatore sa leggere.
//  2. Nessuno dei due nomi era in `JOB_CRON`, quindi anche un battito perfetto non
//     sarebbe stato cercato da nessuno. Conferma dal vivo, GET /api/health:
//     «job senza battito: push-dispatch,news-cron,fattura-sync,…» — i due job di
//     retention non comparivano né fra i vivi né fra i muti: invisibili.
//
// ─── LA REGOLA CHE QUESTO BLOCCO SORVEGLIA ──────────────────────────────────
//
// Una sola: **un battito o è leggibile da chi lo cerca, o non è un battito.** Da
// qui due prove — la forma del contesto che le funzioni SQL scrivono, e il fatto
// che il nome del job sia in `JOB_CRON` oppure DICHIARATO fuori con la sua
// ragione (`JOB_CRON_NON_SORVEGLIATI`, che è una costante e non un commento
// proprio perché un lock possa leggerla).
//
// ⚠️ PERIMETRO DICHIARATO: le prove qui sotto guardano i due job di retention di
// questo dominio. In `supabase/migrations/` ce ne sono altri undici che scrivono
// un `fingerprint` `cron:*` con la stessa forma piatta (iscrizioni, audit-docente,
// bonifica-pii): è un debito misurato, non un'omissione — e nessuno di quelli è
// citato dall'informativa come automa.
// =============================================================================

const BATTITI_DA_LEGGERE: { job: string; funzione: string }[] = [
  { job: 'presenze-giustificazioni-retention', funzione: 'presenze_giustificazioni_retention_tick' },
  { job: 'notifiche-retention', funzione: 'notifiche_retention_tick' },
]

/** L'ULTIMA migrazione che (ri)definisce una funzione: è quella che vale. */
function ultimaDefinizione(funzione: string) {
  return [...SQL_MIGRAZIONI]
    .reverse()
    .find(({ sql }) =>
      new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${funzione}\\s*\\(`, 'i').test(sql),
    )
}

describe('lock · i lavori di scadenza lasciano un battito che qualcuno sa leggere', () => {
  it.each(BATTITI_DA_LEGGERE)(
    '$job scrive un contesto della forma che `controlloBattitoCron` legge',
    ({ job, funzione }) => {
      const def = ultimaDefinizione(funzione)
      expect(def, `nessuna migrazione definisce public.${funzione}()`).toBeTruthy()
      const sql = def!.sql

      expect(
        /jsonb_build_object\(\s*'campi'/i.test(sql),
        `\`${funzione}\` scrive un \`contesto\` PIATTO. \`controlloBattitoCron\` legge ` +
          `\`riga.contesto?.campi\` e con \`continue\` scarta tutto il resto: quel battito non ` +
          `viene contato da nessuno, e il lavoro può smettere di girare senza che nulla lo dica. ` +
          `Il formato è quello di \`logEvento\`: tutto annidato sotto \`campi\`.`,
      ).toBe(true)

      expect(
        /'esito'\s*,\s*'ok'/i.test(sql),
        `\`${funzione}\` non scrive \`esito: 'ok'\` nel battito: \`controlloBattitoCron\` scarta ` +
          `le righe con qualunque altro esito. Il DOMINIO del lavoro va in un campo suo — ` +
          `l'\`esito\` risponde a «è andata bene?», non a «di che cosa si occupa».`,
      ).toBe(true)

      expect(
        new RegExp(`'operazione'\\s*,\\s*'${job}'`, 'i').test(sql),
        `\`${funzione}\` non scrive \`operazione: '${job}'\`: è la chiave con cui ` +
          `\`controlloBattitoCron\` associa il battito al job, e senza combacia con niente.`,
      ).toBe(true)

      expect(
        /'info'\s*,\s*'cron'/i.test(sql),
        `\`${funzione}\` non scrive il battito come \`(livello, evento) = ('info', 'cron')\`. ` +
          `Un battito scritto guardando alla NATURA DEL DATO trattato (\`gdpr\`) invece che alla ` +
          `NATURA DEL SEGNALE non lo trova nessun controllo: il filtro è \`.eq('evento','cron')\`.`,
      ).toBe(true)
    },
  )

  it.each(BATTITI_DA_LEGGERE)('$job è sorvegliato, oppure dichiarato fuori con la sua ragione', ({ job }) => {
    const sorvegliato = JOB_CRON.some((j) => j.nome === job)
    const fuori = JOB_CRON_NON_SORVEGLIATI.find((j) => j.nome === job)
    expect(
      sorvegliato || fuori !== undefined,
      `\`${job}\` non è in \`JOB_CRON\` e non è dichiarato in \`JOB_CRON_NON_SORVEGLIATI\`: ` +
        `non compare né fra i job vivi né fra quelli muti di /api/health, cioè è invisibile. ` +
        `Se sorvegliarlo non ha senso (cadenza mensile), va detto lì con la ragione — una ` +
        `decisione in una costante, non in un commento.`,
    ).toBe(true)
    if (!sorvegliato) {
      expect(
        fuori!.perche.length,
        `\`${job}\` è dichiarato fuori dalla sorveglianza senza dire perché.`,
      ).toBeGreaterThan(30)
    }
  })
})

/** La sezione «Conservazione dei dati» DELIMITATA: dal titolo al suo `</section>`. */
const SEZIONE_CONSERVAZIONE = (() => {
  const dal = informativa.indexOf('Conservazione dei dati')
  const al = informativa.indexOf('</section>', dal)
  return informativa.slice(dal, al === -1 ? undefined : al)
})()

/** Le voci dell'elenco, a spazi normalizzati: in JSX il testo va a capo dove capita. */
const VOCI_CONSERVAZIONE = SEZIONE_CONSERVAZIONE.split('<li>')
  .slice(1)
  .map((voce) => voce.split('</li>')[0].replace(/\s+/g, ' ').trim())

/** «cancellati automaticamente», «cancellato automaticamente», «automaticamente eliminati»… */
const PROMESSA_DI_AUTOMATISMO =
  /(?:cancellat|eliminat|anonimizzat|rimoss)\w*\s+automaticamente|automaticamente\s+(?:cancellat|eliminat|anonimizzat|rimoss)\w*/i

/**
 * Chi esegue davvero ciascuna promessa di automatismo dell'informativa.
 * Una voce nuova con la parola «automaticamente» e senza riga qui = prova rossa:
 * è il punto in cui va detto, per iscritto, chi mantiene la promessa.
 */
const AUTOMI_DICHIARATI: { voce: RegExp; etichetta: string; job: string }[] = [
  {
    voce: /pre-iscrizione non accolte/i,
    etichetta: 'domande di pre-iscrizione non accolte',
    job: 'iscrizioni-retention',
  },
  {
    voce: /log tecnici/i,
    etichetta: 'log tecnici di accesso e di utilizzo',
    job: 'app-log-purge',
  },
  {
    voce: /motivo dell.{0,8}assenza/i,
    etichetta: 'motivo dell’assenza e note dell’appello',
    job: JOB_SCADENZA,
  },
]

/** Le migrazioni che installano `job` con quel nome (`cron.schedule('job', …)`). */
function migrazioniCheInstallano(job: string) {
  const re = new RegExp(`cron\\.schedule\\s*\\(\\s*'${job}'`, 'i')
  return SQL_MIGRAZIONI.filter(({ sql }) => re.test(sql))
}

/**
 * La migrazione è marcata «NON APPLICATA» dall'agente che l'ha scritta e nessuno
 * ha ancora attestato il contrario con una riga «APPLICATA il AAAA-MM-GG».
 */
function soloSuCarta(sql: string): boolean {
  return /NON\s+APPLICATA/i.test(sql) && !/(?<!NON\s{1,4})APPLICATA\s+(?:in\s+produzione\s+)?il\s+\d{4}-\d{2}-\d{2}/i.test(sql)
}

/** Le voci che promettono un automatismo, con l'automa che ciascuna dichiara. */
const PROMESSE = VOCI_CONSERVAZIONE.filter((v) => PROMESSA_DI_AUTOMATISMO.test(v)).map((voce) => ({
  voce,
  automa: AUTOMI_DICHIARATI.find((a) => a.voce.test(voce)),
}))

describe('lock · l’informativa non promette automatismi che non esistono', () => {
  it('la sezione «Conservazione dei dati» si legge, e ha le sue voci (sanity)', () => {
    // Se il titolo o la forma dell'elenco cambiano, tutte le prove qui sotto
    // girerebbero sul vuoto e direbbero «verde» senza aver guardato niente.
    expect(
      VOCI_CONSERVAZIONE.length,
      'nessun `<li>` fra «Conservazione dei dati» e il suo `</section>` in src/app/privacy/page.tsx: ' +
        'la sezione è stata spostata o riscritta, e questo lock non sta più leggendo l’informativa.',
    ).toBeGreaterThanOrEqual(5)
  })

  it('la mappa degli automi non invecchia: ogni voce dichiarata esiste nell’informativa (sanity)', () => {
    for (const { voce, etichetta } of AUTOMI_DICHIARATI) {
      expect(
        VOCI_CONSERVAZIONE.some((v) => voce.test(v)),
        `Questo lock dichiara chi esegue la voce «${etichetta}», ma nell’informativa quella voce ` +
          `non si trova più. Se è stata riscritta, aggiorna la mappa: una mappa che punta a un ` +
          `testo che non c'è più non sorveglia niente.`,
      ).toBe(true)
    }
  })

  it('ogni promessa di automatismo dice CHI la esegue', () => {
    for (const { voce, automa } of PROMESSE) {
      expect(
        automa,
        `Questa voce dell’informativa promette una cancellazione automatica e nessuno in questo ` +
          `lock dichiara chi la esegue:\n  «${voce}»\n` +
          `Aggiungi la riga in \`AUTOMI_DICHIARATI\` con il nome del lavoro che la mantiene — ` +
          `oppure togli la parola «automaticamente»: il termine si può promettere, la macchina no, ` +
          `finché non c'è.`,
      ).toBeTruthy()
    }
  })

  it('e l’automa esiste nel repo, schedulato con quel nome', () => {
    for (const { automa } of PROMESSE) {
      if (!automa) continue
      expect(
        migrazioniCheInstallano(automa.job).length,
        `L’informativa promette che «${automa.etichetta}» è cancellato automaticamente, e in ` +
          `supabase/migrations/ non c'è nessun \`cron.schedule('${automa.job}', …)\`. ` +
          `La promessa non è mantenuta da niente.`,
      ).toBeGreaterThan(0)
    }
  })

  it('e non vive solo sulla carta: la migrazione che lo installa è APPLICATA', () => {
    for (const { automa } of PROMESSE) {
      if (!automa) continue
      const installazioni = migrazioniCheInstallano(automa.job)
      const suCarta = installazioni.filter(({ sql }) => soloSuCarta(sql))
      expect(
        suCarta.length,
        `L’informativa promette alle famiglie che «${automa.etichetta}» è cancellato ` +
          `AUTOMATICAMENTE, e il lavoro \`${automa.job}\` che dovrebbe farlo esiste soltanto nel ` +
          `file ${suCarta.map((m) => m.file).join(', ')}, marcato «NON APPLICATA».\n` +
          `Un file SQL non cancella niente: finché la migrazione non è applicata al database, ` +
          `quella frase è una dichiarazione GDPR non veritiera (art. 13 §2 lett. a) su un dato ` +
          `relativo alla salute di un minore.\n` +
          `Le due strade, e nessuna terza: (a) applicare la migrazione e attestarlo nella sua ` +
          `testata con «APPLICATA il AAAA-MM-GG»; (b) togliere la parola «automaticamente» dalla ` +
          `voce — il termine in mesi resta dichiarato e resta sorvegliato dalle prove qui sopra.`,
      ).toBe(0)
    }
  })
})
