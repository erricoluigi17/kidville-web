import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL REGISTRO DEI CARICAMENTI — l'oggetto che nessuna riga nomina ancora   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Il modulo `/anagrafica-personale` è un wizard di quattro passi: la scansione del
 * documento d'identità si carica al TERZO (`iscrizione/personale/upload:POST`, che
 * scrive subito nel bucket e restituisce il percorso), i consensi e l'invio stanno
 * al QUARTO (`iscrizione/personale:POST`, che è ciò che crea la riga in
 * `pratiche_personale`).
 *
 * ── IL DIFETTO, CHE NON È UN CASO DI ABUSO MA QUELLO NORMALE ────────────────
 *
 * Fra i due passi c'è una persona che può chiudere la pagina. Fino all'11/08/2026
 * chi lo faceva lasciava la fotografia della propria carta d'identità nel bucket a
 * tempo indeterminato: senza il nome del file — che la rotta di caricamento butta
 * via apposta, perché è quasi sempre `carta-identita-<cognome>.pdf` — e senza
 * NESSUNA riga che dicesse di chi fosse, cioè nemmeno identificabile per
 * cancellarla se quella persona l'avesse chiesto.
 *
 * È lo stato che `gdpr/retention-personale:POST` chiama, con parole sue, «il modo
 * peggiore di conservare un dato personale». Là quel ramo è difeso con un `return`
 * e un log a livello `error`; qui lo stesso stato si CREAVA per costruzione a ogni
 * modulo abbandonato — e la retention non poteva vederlo, perché parte da
 * `pratiche_personale` e `anagrafica_personale`, quindi guarda solo gli oggetti GIÀ
 * referenziati, mai quelli orfani.
 *
 * C'è anche una promessa scritta da mantenere: il terzo consenso
 * (`presa_visione_copia_documento`, testo in `personale-template.ts`, archiviato
 * con la sua versione in `consents_log`) dice che la copia «è cancellata entro 12
 * mesi dalla cessazione del rapporto, ed entro 90 giorni se questa richiesta non
 * viene approvata». Per un oggetto orfano nessuno dei due termini decorre mai: non
 * c'è né una pratica né una cessazione da cui contare.
 *
 * ── LE TRE COSE CHE IL REGISTRO FA, E CHE NIENT'ALTRO FACEVA ────────────────
 *
 *  1. **Rende l'orfano identificabile e spazzabile.** Una riga con `pratica_id`
 *     NULL più vecchia della soglia è un oggetto che nessuno ha reclamato.
 *  2. **Dimostra che l'oggetto ESISTE.** `documento_path` è `required: true` nel
 *     template ed è la ragione per cui il modulo esiste, ma il gate di forma si
 *     soddisfaceva con una stringa inventata `documenti/<uuid>/<uuid>.pdf` — e
 *     quella forma è documentata in un repository PUBBLICO. La Segreteria avrebbe
 *     visto una pratica «completa» e lo avrebbe scoperto solo cliccando.
 *  3. **Impone «un oggetto, un proprietario».** La migrazione `20260811205643`
 *     dichiara l'invariante come un fatto — «è ciò che impedisce alla retention
 *     della pratica di cancellare il file che l'anagrafica sta ancora usando» — ma
 *     nessuno la imponeva: su `documento_path` non c'è unicità, e un percorso
 *     legittimo trapelato da un URL firmato inoltrato poteva essere allegato a una
 *     pratica per un'ALTRA sede, facendo firmare a quella Segreteria il documento
 *     d'identità di una persona che non è sua.
 *
 * ── PERCHÉ QUI E NON DENTRO LE DUE ROUTE ────────────────────────────────────
 *
 * Perché è una regola valida per due strade — chi scrive l'oggetto e chi lo
 * reclama — e in questo repo una regola che vive in due posti diverge alla prima
 * modifica: è la lezione di `@/lib/allegati/mime` e di `rimozione-verificata.ts`.
 * La terza strada è la spazzata, che deve applicare la STESSA soglia con cui il
 * registro è stato scritto.
 *
 * ── NEI LOG MAI IL PERCORSO ─────────────────────────────────────────────────
 *
 * Non contiene il nome del file, ma è la CHIAVE con cui si firma la fotografia di
 * un documento d'identità, e `app_log` è interrogabile in SQL per 30 giorni. Di qui
 * escono conteggi, esiti e codici d'errore. Mai un percorso.
 */

/** Il bucket privato delle scansioni, separato da quello dei documenti dei minori. */
export const BUCKET_DOCUMENTI_PERSONALE = 'documenti_personale'

/** La tabella del registro (migrazione `20260811234334_caricamenti_personale.sql`). */
const TABELLA = 'caricamenti_personale'

/**
 * Da quante ore un caricamento non reclamato è un ORFANO.
 *
 * Ventiquattro, e il numero ha due lati. Il modulo si compila in una sessione — fra
 * il terzo e il quarto passo passano minuti — ma capita di interrompersi e
 * riprendere la mattina dopo, e chi lo fa non deve ritrovarsi il documento sparito.
 * Dall'altro lato, oltre quella soglia non c'è più nessuna sessione da salvare: c'è
 * solo la fotografia di una carta d'identità che nessuno ha mai reclamato.
 *
 * Chi ripresenta un percorso già spazzato prende un 400 sotto il campo, e la frase
 * è già quella giusta: «Allega di nuovo il documento dal modulo».
 */
export const ORE_CARICAMENTO_IN_SOSPESO = 24

/**
 * Quanti orfani si tolgono per giro.
 *
 * Un tetto ESPLICITO, per la stessa ragione scritta in `retention-personale`: una
 * lettura senza `.limit()` non è «tutte le righe», è «tutte finché qualcun altro non
 * decide di tagliare» — e il taglio di qualcun altro arriva muto. Le più vecchie per
 * prime, così un lotto pieno non lascia indietro proprio quelle in ritardo da più
 * tempo; il giro successivo riprende da lì.
 */
export const TETTO_SPAZZATA = 25

/**
 * Tabella assente.
 *
 * ⚠️ Non è «lo stato del DB E2E della CI», che è come questa riga si descriveva fino
 * al 12/08/2026: è anche lo stato della PRODUZIONE finché `20260811234334` non è
 * applicata, misurato con `pg_class` mentre il bucket `documenti_personale` c'era già.
 * La differenza non è lessicale — su quella frase poggiavano due fail-open, e in
 * produzione lasciavano nel bucket documenti d'identità che nessuna riga nominava.
 */
const TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

/** Colonna assente: stesso trattamento — il registro non ha la forma che ci aspettiamo. */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/** Il codice PostgREST/Postgres di un errore che NON è stato lanciato ma restituito. */
function codiceDi(errore: unknown): string {
  const c = (errore as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

/** Il registro non esiste su questo database, o non ha la forma attesa. */
function registroAssente(errore: unknown): boolean {
  const c = codiceDi(errore)
  return TABELLA_ASSENTE.has(c) || COLONNA_ASSENTE.has(c)
}

export type EsitoRegistrazione = {
  /** `true` se la riga di registro esiste: solo allora l'oggetto è sorvegliato. */
  registrato: boolean
  /** `true` se il registro non c'è su questo database (migrazione non applicata). */
  degradato: boolean
}

/**
 * Scrive nel registro l'oggetto appena caricato.
 *
 * ⚠️ IL CHIAMANTE DEVE RITIRARE L'OGGETTO SE QUESTA FALLISCE, e non è una cautela:
 * un oggetto senza riga di registro è ESATTAMENTE l'orfano invisibile che tutto
 * questo modulo esiste per impedire. Un caricamento fallito costa a una maestra un
 * secondo tentativo; un oggetto non registrato costa la fotografia del suo documento
 * d'identità conservata per sempre, e da nessuno cancellabile.
 *
 * ⚠️ E VALE ANCHE COL REGISTRO ASSENTE (`degradato: true`), che fino al 12/08/2026
 * era l'eccezione dichiarata: «lì non c'è niente da ritirare in modo sensato, perché
 * su un database senza questa tabella non c'è nemmeno il bucket». **La premessa era
 * falsa**, misurata in produzione con `pg_class` e `storage.buckets`: bucket
 * `documenti_personale` PRESENTE (migrazione `20260811205643`, applicata), tabella
 * `caricamenti_personale` ASSENTE (migrazione `20260811234334`, non ancora
 * applicata). Le due non viaggiano insieme, e l'unica finestra in cui l'eccezione
 * poteva scattare era proprio quella in cui il bucket c'era già.
 *
 * `degradato` resta nel valore di ritorno perché distingue due fatti diversi per chi
 * legge `app_log` — «la tabella non c'è» e «la tabella c'è e non ha risposto» — ma
 * non è un permesso: chi chiama ritira in entrambi i casi. Il livello resta `error`,
 * perché una tabella che manca in produzione è configurazione mancante e non una nota
 * a piè di pagina (AGENTS §4).
 */
export async function registraCaricamento(
  supabase: SupabaseClient,
  percorso: string,
  operazione: string,
): Promise<EsitoRegistrazione> {
  // PostgREST NON lancia: ritorna `{ error }`, e un `try/catch` attorno non
  // scatterebbe mai (AGENTS §7).
  const { error } = await supabase.from(TABELLA).insert({ percorso })
  if (!error) return { registrato: true, degradato: false }

  const degradato = registroAssente(error)
  logEvento(
    'storage',
    'error',
    {
      operazione,
      esito: degradato ? 'registro-caricamenti-assente' : 'registro-caricamenti-non-scritto',
      bucket: BUCKET_DOCUMENTI_PERSONALE,
      error_code: codiceDi(error),
      msg: degradato
        ? `${operazione}: la tabella ${TABELLA} non esiste su questo database, quindi l'oggetto appena caricato resta nel bucket senza nessuna riga che lo nomini. Applicare la migrazione 20260811234334_caricamenti_personale.sql`
        : `${operazione}: registro dei caricamenti non scritto, l'oggetto viene ritirato dal bucket invece di restarci senza proprietario`,
    },
    error,
  )
  return { registrato: false, degradato }
}

export type EsitoReclamo = {
  /** `true` se il percorso può essere allegato a una pratica. */
  ammesso: boolean
  /**
   * `true` se il registro NON ESISTE su questo database (tabella o colonna assenti).
   *
   * È uno stato diverso da `degradato` e non un suo caso particolare: qui non è
   * fallita UNA lettura, è che su questo database non c'è NESSUN percorso
   * verificabile — perché la porta di caricamento, davanti allo stesso stato, ritira
   * l'oggetto e non consegna niente. Vedi la testata della funzione.
   */
  assente: boolean
  /** `true` se il registro c'è, non ha risposto, e si è scelto di non bloccare. */
  degradato: boolean
}

/**
 * IL PERCORSO ESISTE DAVVERO E NON È DI NESSUN ALTRO?
 *
 * Una lettura sola, prima dell'INSERT, che risponde a tutte e due le domande: la
 * riga c'è (l'oggetto è passato dalla nostra porta di caricamento) e `pratica_id` è
 * NULL (nessun'altra pratica lo nomina).
 *
 * ── PERCHÉ UN GUASTO DI LETTURA NON BLOCCA (`degradato`) ───────────────────
 *
 * Perché questo è un presidio IN PIÙ sopra il gate di forma, e non deve diventare
 * un modo nuovo di perdere l'anagrafica di una persona vera: se il registro non
 * risponde, la pratica passa e il fatto resta scritto. La scelta è sicura perché
 * chi bussa non può PROVOCARE quel guasto — non c'è nessun parametro della
 * richiesta che decida se questa query riesce.
 *
 * ── PERCHÉ IL REGISTRO ASSENTE INVECE BLOCCA (`assente`) ───────────────────
 *
 * Fino al 12/08/2026 i due stati erano lo stesso `{ammesso: true, degradato: true}`,
 * e la ragione scritta accanto al fail-open citava un solo scenario: «`warn` se la
 * tabella non c'è, è lo stato dichiarato del DB E2E della CI». Due misure hanno
 * smontato quella frase:
 *
 *  · **lo stato è quello della PRODUZIONE, non della CI.** `pg_class` il 12/08:
 *    tabella `caricamenti_personale` assente (migrazione `20260811234334`, non
 *    applicata) mentre il bucket `documenti_personale` c'è (`20260811205643`,
 *    applicata). Le due migrazioni non viaggiano insieme;
 *  · **sulla CI quel ramo non ci si arriva.** La rotta chiama questa funzione DOPO
 *    il controllo della sede, e `sediReali` esclude la sede E2E (`isScuolaE2E`):
 *    sul database della CI la richiesta esce con 400 `SEDE_DA_SPECIFICARE` prima.
 *
 * In quello stato il fail-open non protegge nessuna persona vera, perché nessuna
 * PUÒ avere un percorso valido: `registraCaricamento` fallisce con lo stesso codice,
 * la rotta di upload ritira l'oggetto e risponde 500, quindi da quella porta non
 * esce nemmeno un percorso. Protegge soltanto chi il percorso se lo INVENTA — la
 * forma `documenti/<uuid>/<uuid>.pdf` è documentata in un repository pubblico — e
 * la Segreteria si troverebbe una pratica «completa» che punta a un oggetto che non
 * esiste: il difetto n. 2 dell'elenco in cima a questo file, ricreato dalla difesa
 * stessa. Con `assente` le due rotte tornano a dire la stessa cosa sullo stesso
 * stato del database.
 *
 * ── I LIVELLI ─────────────────────────────────────────────────────────────
 *
 * Tutti e due `error`, e nessuno dei due è rumore: la tabella che manca in
 * produzione è configurazione mancante (AGENTS §4) e da adesso CHIUDE una porta —
 * il messaggio nomina la migrazione da applicare, perché «400 sul documento» senza
 * quel numero non è diagnosticabile. Gli `esito` restano distinti, ed è lì che chi
 * legge `app_log` separa «non c'è» da «non ha risposto».
 */
export async function caricamentoReclamabile(
  supabase: SupabaseClient,
  percorso: string,
  operazione: string,
): Promise<EsitoReclamo> {
  const { data, error } = await supabase
    .from(TABELLA)
    .select('percorso')
    .eq('percorso', percorso)
    .is('pratica_id', null)
    .maybeSingle()

  if (error) {
    const assente = registroAssente(error)
    logEvento('personale', 'error', {
      operazione,
      esito: assente ? 'registro-caricamenti-assente' : 'registro-caricamenti-non-letto',
      error_code: codiceDi(error),
      msg: assente
        ? `${operazione}: la tabella ${TABELLA} non esiste su questo database, quindi nessun percorso è verificabile e la scansione non si può accettare. Applicare la migrazione 20260811234334_caricamenti_personale.sql`
        : `${operazione}: registro dei caricamenti non leggibile, il percorso della scansione non è stato verificato e la pratica è stata accettata lo stesso`,
    })
    return { ammesso: !assente, assente, degradato: !assente }
  }

  return { ammesso: data !== null, assente: false, degradato: false }
}

/**
 * Collega l'oggetto alla pratica che l'ha appena reclamato: da qui in avanti non è
 * più in sospeso, e non è più reclamabile da nessun'altra.
 *
 * Best-effort per costruzione — la pratica è già scritta e non si torna indietro per
 * questo — ma **si verifica lo STATO, non l'intenzione**: `.select()` dopo l'`update`
 * dice quante righe sono state toccate davvero, perché un `update` che non trova
 * niente NON è un errore per PostgREST e passerebbe in silenzio.
 *
 * Zero righe collegate significa che la spazzata toglierà quell'oggetto fra qualche
 * ora mentre una pratica lo nomina ancora: la Segreteria aprirebbe una scheda con il
 * documento mancante. È un guasto, si dichiara `error`, e l'`entita_id` nel log — un
 * uuid, che `redact()` lascia passare per forma — è ciò che lo rende riparabile.
 */
export async function collegaCaricamento(
  supabase: SupabaseClient,
  percorso: string,
  praticaId: string,
  operazione: string,
): Promise<void> {
  const { data, error } = await supabase
    .from(TABELLA)
    .update({ pratica_id: praticaId })
    .eq('percorso', percorso)
    .is('pratica_id', null)
    .select('percorso')

  const collegate = Array.isArray(data) ? data.length : 0
  if (error || collegate === 0) {
    const assente = error ? registroAssente(error) : false
    logEvento(
      'personale',
      assente ? 'warn' : 'error',
      {
        operazione,
        esito: assente ? 'registro-caricamenti-assente' : 'caricamento-non-collegato',
        entita_id: praticaId,
        error_code: codiceDi(error),
        msg: assente
          ? `${operazione}: la tabella ${TABELLA} non esiste su questo database, nessun collegamento da scrivere`
          : `${operazione}: la scansione non risulta collegata alla pratica; la spazzata la toglierà entro ${ORE_CARICAMENTO_IN_SOSPESO} ore mentre la pratica la nomina ancora`,
      },
      error ?? undefined,
    )
  }
}

export type EsitoSpazzata = {
  /** Oggetti usciti dal bucket, con la loro riga di registro cancellata. */
  rimossi: number
  /** Oggetti ancora presenti o non verificabili: la riga resta, si riprova. */
  trattenuti: number
  /** `true` se il registro non c'è su questo database. */
  degradato: boolean
}

const NIENTE: EsitoSpazzata = { rimossi: 0, trattenuti: 0, degradato: false }

/**
 * Toglie dal bucket gli oggetti che nessuna pratica ha reclamato entro la soglia.
 *
 * ── PRIMA I FILE, POI LE RIGHE ──────────────────────────────────────────────
 *
 * È la lezione che i tre fratelli della conservazione hanno già pagato: al
 * contrario, un errore a metà lascerebbe le scansioni nell'archivio senza più
 * nessuna riga che le nomini — cioè ricreerebbe, con un'altra strada, esattamente lo
 * stato che questa funzione esiste per togliere. E la rinuncia è PER OGGETTO: una
 * scansione che non esce trattiene LA SUA riga, non l'intero lotto.
 *
 * `rimuoviEVerifica` è preso in prestito e non riscritto: verifica lo STATO invece
 * del conteggio, e in particolare tratta il file GIÀ assente come esito raggiunto —
 * senza quella distinzione un file mancante bloccherebbe la spazzata per sempre.
 *
 * ── NON LANCIA MAI ──────────────────────────────────────────────────────────
 *
 * La chiama una rotta pubblica dopo un caricamento riuscito: un guasto della pulizia
 * non può diventare un caricamento fallito per una maestra che ha fatto tutto bene.
 * Ogni ramo che rinuncia lascia però una riga — un `catch` che non logga è un bug
 * (AGENTS §6).
 */
export async function spazzaCaricamentiSospesi(
  supabase: SupabaseClient,
  operazione: string,
  opzioni: { ore?: number; tetto?: number; adesso?: number } = {},
): Promise<EsitoSpazzata> {
  const ore = opzioni.ore ?? ORE_CARICAMENTO_IN_SOSPESO
  const tetto = opzioni.tetto ?? TETTO_SPAZZATA
  const soglia = new Date((opzioni.adesso ?? Date.now()) - ore * 60 * 60 * 1000).toISOString()

  try {
    const { data, error } = await supabase
      .from(TABELLA)
      .select('percorso')
      .is('pratica_id', null)
      .lt('caricato_il', soglia)
      // Le più vecchie per prime: se il tetto taglia, taglia le meno in ritardo.
      .order('caricato_il', { ascending: true })
      .limit(tetto)

    if (error) {
      const assente = registroAssente(error)
      logEvento('gdpr', assente ? 'warn' : 'error', {
        operazione,
        esito: assente ? 'registro-caricamenti-assente' : 'spazzata-lettura-fallita',
        bucket: BUCKET_DOCUMENTI_PERSONALE,
        error_code: codiceDi(error),
        msg: assente
          ? `${operazione}: la tabella ${TABELLA} non esiste su questo database, nessuna spazzata`
          : `${operazione}: elenco dei caricamenti in sospeso non leggibile, nessun oggetto rimosso`,
      })
      return { ...NIENTE, degradato: assente }
    }

    const percorsi = [
      ...new Set(
        (Array.isArray(data) ? data : [])
          .map((r) => (r as { percorso?: unknown }).percorso)
          .filter((p): p is string => typeof p === 'string' && p.trim() !== ''),
      ),
    ]
    if (percorsi.length === 0) return { ...NIENTE }

    const esito = await rimuoviEVerifica(
      supabase,
      BUCKET_DOCUMENTI_PERSONALE,
      percorsi,
      operazione,
    )
    if (esito.erroreRimozione) {
      // `rimuoviEVerifica` ha già loggato a livello `error`: nessun file è uscito e
      // non c'è niente da verificare. Le righe restano, si riprova al giro dopo.
      return { rimossi: 0, trattenuti: percorsi.length, degradato: false }
    }

    const daNonToccare = new Set(bloccanti(esito))
    const chiudibili = percorsi.filter((p) => !daNonToccare.has(p))
    if (chiudibili.length === 0) {
      return { rimossi: 0, trattenuti: daNonToccare.size, degradato: false }
    }

    const { error: erroreRighe } = await supabase.from(TABELLA).delete().in('percorso', chiudibili)
    if (erroreRighe) {
      // I file sono usciti e le righe li nominano ancora. Non è una perdita di dati
      // — `rimuoviEVerifica` tratta il file già assente come esito raggiunto, quindi
      // il giro dopo chiude comunque — ma è un guasto, e si dichiara.
      logEvento(
        'gdpr',
        'error',
        {
          operazione,
          esito: 'spazzata-righe-non-cancellate',
          bucket: BUCKET_DOCUMENTI_PERSONALE,
          error_code: codiceDi(erroreRighe),
          n_file: chiudibili.length,
          msg: `${operazione}: scansioni orfane rimosse dall'archivio ma righe di ${TABELLA} NON cancellate`,
        },
        erroreRighe,
      )
      return { rimossi: chiudibili.length, trattenuti: daNonToccare.size, degradato: false }
    }

    // IL SUCCESSO SI LOGGA (AGENTS §5), e qui più che altrove: è la sola prova che
    // la promessa scritta nel terzo consenso viene mantenuta. `gdpr` è in
    // `EVENTI_PERSISTITI`, quindi questo `info` resta interrogabile in SQL.
    logEvento('gdpr', 'info', {
      operazione,
      esito: 'caricamenti-sospesi-spazzati',
      bucket: BUCKET_DOCUMENTI_PERSONALE,
      n_file: chiudibili.length,
      n_file_gia_assenti: esito.giaAssenti.length,
      n_file_bloccanti: daNonToccare.size,
      ore,
    })
    return { rimossi: chiudibili.length, trattenuti: daNonToccare.size, degradato: false }
  } catch (e) {
    logEvento(
      'gdpr',
      'error',
      {
        operazione,
        esito: 'spazzata-eccezione',
        bucket: BUCKET_DOCUMENTI_PERSONALE,
        msg: `${operazione}: eccezione durante la spazzata dei caricamenti in sospeso`,
      },
      e,
    )
    return { ...NIENTE }
  }
}
