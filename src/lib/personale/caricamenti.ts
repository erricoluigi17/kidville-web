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
 *     NULL **e** `anagrafica_utente_id` NULL, più vecchia della soglia, è un oggetto
 *     che nessuno ha reclamato. Lo SCHEMA prevede due proprietari dal 12/08/2026
 *     (migrazione `20260812194501`): una pratica in arrivo dal modulo pubblico, oppure
 *     un'anagrafica — quest'ultima è la rotta con cui la Segreteria carica dalla
 *     scheda della persona (`admin/anagrafica-personale/scansione:POST`), che **esiste
 *     dal 13/08/2026** e passa `anagraficaUtenteId` a ogni caricamento.
 *     Guardare una colonna sola, oggi, significa cancellare entro 24 ore la scansione
 *     di una dipendente in servizio mentre il suo fascicolo la nomina: non è più
 *     un'approssimazione in attesa di diventare un difetto, è il difetto.
 *  2. **Dimostra che gli oggetti ESISTONO.** `documento_fronte_path` e
 *     `documento_retro_path` sono `required: true` nel template e sono la ragione per
 *     cui il modulo esiste, ma il gate di forma si soddisfaceva con una stringa
 *     inventata `documenti/<uuid>/<uuid>.pdf` — e quella forma è documentata in un
 *     repository PUBBLICO. La Segreteria avrebbe visto una pratica «completa» e lo
 *     avrebbe scoperto solo cliccando. Con due facce il difetto raddoppia: basta che
 *     UNA delle due sia inventata perché la scheda sia mezza vuota.
 *  3. **Impone «un oggetto, un proprietario».** La migrazione `20260811205643`
 *     dichiara l'invariante come un fatto — «è ciò che impedisce alla retention
 *     della pratica di cancellare il file che l'anagrafica sta ancora usando» — ma
 *     nessuno la imponeva: sulle colonne dei percorsi non c'è unicità, e un percorso
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
 * LO STESSO NOME, ESPORTATO — e non è una comodità.
 *
 * `admin/anagrafica-personale/scansione:POST` cancella la riga del percorso che
 * sostituisce, e quella cancellazione non può vivere qui dentro: non è una regola
 * del registro, è un passo della sostituzione (prima la colonna, poi il file, poi
 * la riga). Senza questo export la rotta scriverebbe il nome della tabella una
 * seconda volta, e due nomi per lo stesso registro sono una cancellazione che gira
 * su una tabella diversa da quella in cui si scrive — la stessa forma di difetto
 * che tutta la testata di questo file racconta.
 */
export { TABELLA as TABELLA_CARICAMENTI }

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
 * ⚠️ IN PRODUZIONE LA TABELLA C'È, e questa riga ha già detto il contrario due volte.
 * Prima si descriveva come «lo stato del DB E2E della CI»; poi, corretta il
 * 12/08/2026, come «anche lo stato della PRODUZIONE finché `20260811234334` non è
 * applicata». Rimisurato lo stesso giorno:
 *
 *     select to_regclass('public.caricamenti_personale') is not null;   → true
 *
 * e `20260811234334` risulta in `supabase_migrations.schema_migrations`. Restano
 * assenti il DB E2E della CI (che non è migrato) e la finestra fra una migrazione e
 * il deploy che la usa.
 *
 * La lezione che questo commento ha pagato due volte: **una frase sullo stato del
 * database invecchia, la query no.** Chi legge esegua quella riga invece di credere a
 * questa — su questa frase poggiavano due fail-open, e finché è rimasta vera in
 * produzione lasciavano nel bucket documenti d'identità che nessuna riga nominava.
 */
const TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

/** Colonna assente: stesso trattamento — il registro non ha la forma che ci aspettiamo. */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * Le migrazioni che rendono verificabile un percorso, NOMINATE TUTTE E DUE.
 *
 * I codici non le distinguono: `PGRST205` dice «manca la tabella», `PGRST204`/`42703`
 * dicono «manca una colonna» — e dal 12/08/2026 la colonna che può mancare è
 * `anagrafica_utente_id`, che arriva dalla seconda. Un messaggio che ne nominasse una
 * sola manderebbe chi indaga a riapplicare quella che è già applicata, cioè a
 * concludere che il problema non c'è.
 */
const MIGRAZIONI_DEL_REGISTRO =
  '20260811234334_caricamenti_personale.sql e 20260812194501_documento_fronte_retro.sql'

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

/** Le facce chieste, già normalizzate: vedi {@link facceChieste}. */
export type FacceChieste = {
  /**
   * I percorsi DISTINTI e non vuoti: è su questi, e solo su questi, che si interroga il
   * registro. `percorso` è la PRIMARY KEY, quindi due volte lo stesso percorso è una
   * riga sola — contarlo due volte farebbe gridare un fallimento parziale che non
   * esiste, «attesi 2, collegati 1» su un oggetto perfettamente collegato.
   */
  distinti: string[]
  /**
   * Gli INDICI (nell'array chiesto) delle facce arrivate SENZA percorso.
   *
   * ⚠️ Non si scartano, e questa è la correzione di un difetto misurato il 12/08/2026.
   * Fino a quel giorno la normalizzazione le buttava via PRIMA di contare, e il difetto
   * colpiva il cuore del disegno: `[fronte, '']` diventava un array di UNO, quindi
   * `n_attesi` valeva 1 invece di 2, il reclamo rispondeva `ammesso: true` e il
   * collegamento non emetteva nemmeno una riga di log. L'aritmetica che qui sostituisce
   * la race non poteva accorgersi della faccia mancante, perché la faccia mancante era
   * già sparita dall'aritmetica. `''` non è «niente da verificare»: è «il retro non c'è».
   */
  vuote: number[]
  /** Quante facce sono state chieste in tutto: `distinti.length + vuote.length`. */
  attese: number
  /**
   * Per ogni percorso distinto, gli indici dei campi a cui corrisponde.
   *
   * Serve a rispondere «quale faccia» senza far uscire un percorso dal modulo: chi
   * risponde 400 riceve indici e li rimappa sui propri id di campo.
   */
  indici: Map<string, number[]>
}

/**
 * LA NORMALIZZAZIONE DELLE FACCE, IN UN POSTO SOLO — ed è esportata perché lo sia.
 *
 * Serve identica a tutte e tre le strade: chi verifica (`caricamentiReclamabili`), chi
 * collega (`collegaCaricamenti`) e il presidio dell'approvazione in
 * `admin/pratiche-personale`. Quest'ultimo la ricopiava — `[...new Set(percorsi)]`,
 * senza `trim()` — e le due copie erano DIVERGENTI dal primo giorno: è la lezione di
 * `@/lib/allegati/mime` e di `rimozione-verificata.ts`, ripetuta dentro il file che la
 * cita. Perciò questa funzione è pubblica: una regola valida per tre strade non si
 * tiene privata sperando che nessuno la riscriva.
 */
export function facceChieste(percorsi: readonly string[]): FacceChieste {
  const indici = new Map<string, number[]>()
  const vuote: number[] = []

  percorsi.forEach((grezzo, i) => {
    const percorso = typeof grezzo === 'string' ? grezzo.trim() : ''
    if (percorso === '') {
      vuote.push(i)
      return
    }
    const dove = indici.get(percorso)
    if (dove) dove.push(i)
    else indici.set(percorso, [i])
  })

  const distinti = [...indici.keys()]
  return { distinti, vuote, attese: distinti.length + vuote.length, indici }
}

/** I `percorso` di una risposta PostgREST, senza dare per scontata la forma. */
function percorsiDi(data: unknown): string[] {
  return (Array.isArray(data) ? data : [])
    .map((r) => (r as { percorso?: unknown }).percorso)
    .filter((p): p is string => typeof p === 'string')
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
 * falsa**: il bucket `documenti_personale` (migrazione `20260811205643`) e il registro
 * (`20260811234334`) non viaggiano insieme, e l'unica finestra in cui l'eccezione
 * poteva scattare era proprio quella in cui il bucket c'era già.
 *
 * `degradato` resta nel valore di ritorno perché distingue due fatti diversi per chi
 * legge `app_log` — «la tabella non c'è» e «la tabella c'è e non ha risposto» — ma
 * non è un permesso: chi chiama ritira in entrambi i casi. Il livello resta `error`,
 * perché una tabella che manca in produzione è configurazione mancante e non una nota
 * a piè di pagina (AGENTS §4).
 *
 * ── IL `proprietario`: DUE CHIAMANTI, e uno solo lo passa ───────────────────
 *
 * Misurato il 13/08/2026 eseguendo il comando, non dedotto:
 *
 *     grep -rn "registraCaricamento" src/
 *     → src/app/api/iscrizione/personale/upload/route.ts:250      (SENZA proprietario)
 *     → src/app/api/admin/anagrafica-personale/scansione/route.ts:420
 *                                                  ({ anagraficaUtenteId: utenteId })
 *
 * · **La porta PUBBLICA non ha nessuno da dichiarare**, e non per dimenticanza: la
 *   pratica non esiste ancora, arriva al passo dopo, e `collegaCaricamenti` la scrive
 *   allora. Fra i due momenti la riga è legittimamente «in sospeso».
 * · **La porta della SEGRETERIA lo dichiara sempre**, perché lì la persona è già in
 *   anagrafica e l'oggetto nasce collegato nella stessa richiesta.
 *
 * ⚠️ QUESTO BLOCCO È STATO STALE DUE VOLTE, e vale la pena dire come. Fino al
 * 12/08/2026 annunciava al presente una rotta che non c'era; corretto, fino al
 * 13/08/2026 ha affermato l'opposto — «non ha ancora la rotta: sotto
 * `src/app/api/admin/anagrafica-personale/` c'è solo `route.ts`» — mentre la rotta era
 * stata scritta nello stesso lavoro. Il comando che il blocco stesso prescriveva come
 * prova (`grep -rn "registraCaricamento" src/`, e `ls` di quella cartella) lo
 * smentiva entrambe le volte.
 *
 * La lezione, che questo file ha ormai pagato tre volte: **un commento che afferma un
 * CONTEGGIO di chiamanti scade il giorno in cui qualcuno chiama la funzione.** Chi
 * legge esegua il `grep`; chi aggiunge un chiamante aggiorni queste righe. È la stessa
 * disciplina già scritta nella testata gemella di `@/lib/upload/carica-file`.
 *
 * ⚠️ E il parametro resta OBBLIGATORIO da dichiarare quando c'è un proprietario, per
 * una ragione che non è di stile: chi carica per una persona già in anagrafica e NON
 * lo passa non lascia una riga imprecisa, lascia una riga «in sospeso» — `pratica_id
 * is null` **e** `anagrafica_utente_id is null` — e `spazzaCaricamentiSospesi` toglie
 * dal bucket entro {@link ORE_CARICAMENTO_IN_SOSPESO} ore la scansione di una persona
 * in servizio MENTRE `anagrafica_personale` la nomina. Il fascicolo punterebbe a un
 * file che non c'è più: è il caso peggiore possibile, ed è il motivo per cui il
 * proprietario si DICHIARA invece di essere dedotto dal chiamante.
 */
export async function registraCaricamento(
  supabase: SupabaseClient,
  percorso: string,
  operazione: string,
  proprietario?: { anagraficaUtenteId: string },
): Promise<EsitoRegistrazione> {
  // La colonna si valorizza SOLO quando c'è un proprietario: mandarla a `null`
  // esplicito su un database che non ce l'ha ancora sarebbe un `PGRST204` gratuito
  // sulla porta pubblica, che di quella colonna non ha bisogno.
  const riga: Record<string, unknown> = { percorso }
  if (proprietario) riga.anagrafica_utente_id = proprietario.anagraficaUtenteId

  // PostgREST NON lancia: ritorna `{ error }`, e un `try/catch` attorno non
  // scatterebbe mai (AGENTS §7).
  const { error } = await supabase.from(TABELLA).insert(riga)
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
        ? `${operazione}: il registro ${TABELLA} non ha su questo database la tabella o la colonna attesa, quindi l'oggetto appena caricato resta nel bucket senza nessuna riga che lo nomini. Applicare le migrazioni ${MIGRAZIONI_DEL_REGISTRO}`
        : `${operazione}: registro dei caricamenti non scritto, l'oggetto viene ritirato dal bucket invece di restarci senza proprietario`,
    },
    error,
  )
  // ⚠️ NIENTE SECONDO TENTATIVO SENZA LA COLONNA SCONOSCIUTA, ed è la tentazione da
  // non seguire: un reinserimento «ripulito» riuscirebbe, e produrrebbe proprio la
  // riga in sospeso descritta qui sopra — la scansione di una persona vera, spazzata
  // entro 24 ore mentre l'anagrafica la nomina. Fallire e far ritirare l'oggetto
  // costa a una dipendente un secondo tentativo; l'altra strada le costa il documento.
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

export type EsitoReclamoMultiplo = EsitoReclamo & {
  /**
   * Gli INDICI delle facce che NON risultano reclamabili — vuoto quando `ammesso`.
   *
   * Serve a chi risponde 400: con due facce, «il documento non va bene» senza dire
   * QUALE costringe una persona a ricaricarle tutte e due. Chi chiama passa i percorsi
   * nell'ordine dei propri campi (`[fronte, retro]`) e rimappa gli indici sugli id
   * (`documento_fronte_path`, `documento_retro_path`).
   *
   * ── ⚠️ PERCHÉ INDICI E NON PERCORSI ────────────────────────────────────────
   *
   * Perché questo è l'UNICO valore che esce da questo modulo, e un percorso è la chiave
   * con cui si firma la fotografia di un documento d'identità. Tutto il file impone che
   * non finisca nei log; farlo uscire nel valore di ritorno sposta solo il punto in cui
   * la regola si rompe — basta un `logEvento({ esito, campi: reclamo })` scritto in
   * buona fede fra sei mesi perché stia in `app_log`, interrogabile in SQL, per 30
   * giorni. Un indice dice «quale faccia», che è tutto ciò che al 400 serve, e non apre
   * niente.
   *
   * Col registro `assente` sono TUTTE, perché la porta è chiusa per tutte; col registro
   * `degradato` restano solo le facce arrivate vuote — quelle non hanno bisogno del
   * registro per essere assenti — perché di nessun'altra è stata DIMOSTRATA la mancanza,
   * e non si accusa un campo per un guasto nostro.
   *
   * ⚠️ `mancanti` conta CAMPI, `n_attesi` conta RIGHE di registro: due percorsi identici
   * sono due campi da respingere ma una riga sola da cercare.
   */
  mancanti: number[]
}

/**
 * I PERCORSI ESISTONO DAVVERO E NON SONO DI NESSUN ALTRO?
 *
 * Una lettura sola, prima dell'INSERT, che risponde a tutte e tre le domande per
 * TUTTE le facce insieme: le righe ci sono (gli oggetti sono passati dalla nostra
 * porta di caricamento), `pratica_id` è NULL e `anagrafica_utente_id` è NULL (nessun
 * altro proprietario li nomina).
 *
 * ── PERCHÉ UNA SOLA ISTRUZIONE E NON UN CICLO ──────────────────────────────
 *
 * È la risposta alla transazionalità, che qui non c'è. Con una lettura per faccia, fra
 * la prima e la seconda si apre una finestra in cui l'altra può essere reclamata da
 * qualcun altro; e al collegamento lo stesso difetto diventa una pratica MEZZA
 * documentata, con due righe di log scoordinate che nessuno sa ricomporre. Con un solo
 * `.in('percorso', percorsi)` non c'è nessuna finestra da ragionare: il verdetto è
 * un'aritmetica sul numero di righe tornate.
 *
 * ── IL SECONDO PROPRIETARIO ────────────────────────────────────────────────
 *
 * `anagrafica_utente_id` (migrazione `20260812194501`) è il proprietario alternativo:
 * gli oggetti che la Segreteria carica dalla scheda di una persona. Senza il suo
 * predicato una pratica pubblica potrebbe reclamare la scansione già appesa
 * all'anagrafica di una collega — cioè il difetto n. 3 in cima a questo file, «far
 * firmare a quella Segreteria il documento d'identità di una persona che non è sua» —
 * e il `check (num_nonnulls(pratica_id, anagrafica_utente_id) <= 1)` se ne
 * accorgerebbe solo dopo, quando la pratica è già entrata.
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
export async function caricamentiReclamabili(
  supabase: SupabaseClient,
  percorsi: string[],
  operazione: string,
): Promise<EsitoReclamoMultiplo> {
  const { distinti, vuote, attese, indici } = facceChieste(percorsi)
  // Nessuna faccia da verificare: nessun viaggio al database, e nessun verdetto da
  // dare. Chi non ha chiesto niente non si vede rifiutare niente — ed è un confine
  // diverso da «mi hai chiesto una faccia che non c'è», che invece si rifiuta.
  if (attese === 0) return { ammesso: true, assente: false, degradato: false, mancanti: [] }

  // ── UNA FACCIA SENZA PERCORSO, E PERCHÉ SI LOGGA ──────────────────────────
  //
  // Arrivare qui con un campo vuoto vuol dire che il gate di forma di chi chiama ha
  // lasciato passare un `required: true`. Non è un abuso e non è un guasto nostro: è
  // un difetto di un'altra riga di codice, e l'unico posto da cui si può vedere è
  // `app_log`. `warn` si persiste per livello, quindi la riga resta interrogabile.
  // Solo conteggi: un percorso non c'è, e gli altri non escono.
  if (vuote.length > 0) {
    logEvento('personale', 'warn', {
      operazione,
      esito: 'faccia-senza-percorso',
      n_attesi: attese,
      n_vuote: vuote.length,
      msg: `${operazione}: ${vuote.length} scansioni su ${attese} sono arrivate senza percorso, quindi non esiste niente da verificare e la pratica non si può accettare così`,
    })
  }

  // Tutte vuote: non c'è nessun percorso da chiedere al registro, e un
  // `.in('percorso', [])` sarebbe un viaggio al database la cui risposta vuota è
  // indistinguibile da un guasto. Il verdetto però c'è, ed è no.
  if (distinti.length === 0) {
    return { ammesso: false, assente: false, degradato: false, mancanti: [...vuote] }
  }

  const { data, error } = await supabase
    .from(TABELLA)
    .select('percorso')
    .in('percorso', distinti)
    .is('pratica_id', null)
    .is('anagrafica_utente_id', null)

  if (error) {
    const assente = registroAssente(error)
    logEvento('personale', 'error', {
      operazione,
      esito: assente ? 'registro-caricamenti-assente' : 'registro-caricamenti-non-letto',
      error_code: codiceDi(error),
      n_attesi: attese,
      msg: assente
        ? `${operazione}: il registro ${TABELLA} non ha su questo database la tabella o la colonna attesa, quindi nessun percorso è verificabile e le scansioni non si possono accettare. Applicare le migrazioni ${MIGRAZIONI_DEL_REGISTRO}`
        : // La coda della frase dice l'ESITO, e deve dire quello vero: il fail-open
          // copre i percorsi che non si sono potuti verificare, non una faccia che non
          // è mai arrivata. Con una faccia vuota la porta si chiude lo stesso, e un
          // messaggio che dicesse «accettata» sarebbe quello su cui, alle tre di notte,
          // si smette di cercare.
          vuote.length > 0
          ? `${operazione}: registro dei caricamenti non leggibile, i percorsi delle scansioni non sono stati verificati; la porta resta comunque chiusa perché ${vuote.length} scansioni su ${attese} sono arrivate senza percorso`
          : `${operazione}: registro dei caricamenti non leggibile, i percorsi delle scansioni non sono stati verificati e la pratica è stata accettata lo stesso`,
    })
    // Registro assente: la porta è chiusa per OGNI campo chiesto, duplicati compresi —
    // chi risponde 400 li deve segnare tutti. Guasto transitorio: passano tutte tranne
    // quelle che non sono mai arrivate, che il fail-open non copre perché la loro
    // assenza non l'ha dimostrata il registro.
    return {
      ammesso: !assente && vuote.length === 0,
      assente,
      degradato: !assente,
      mancanti: assente ? percorsi.map((_, i) => i) : [...vuote],
    }
  }

  const trovati = new Set(percorsiDi(data))
  const mancanti = [...vuote]
  for (const [percorso, dove] of indici) if (!trovati.has(percorso)) mancanti.push(...dove)
  mancanti.sort((a, b) => a - b)
  return { ammesso: mancanti.length === 0, assente: false, degradato: false, mancanti }
}

/**
 * La forma a un percorso solo, per chi ne ha ancora uno solo da verificare.
 *
 * Delega, e non ha una query sua: una regola valida per due strade che vivesse in due
 * posti divergerebbe alla prima modifica — è la lezione di `@/lib/allegati/mime` e di
 * `rimozione-verificata.ts`, ed è già scritta nella testata di questo file.
 */
export async function caricamentoReclamabile(
  supabase: SupabaseClient,
  percorso: string,
  operazione: string,
): Promise<EsitoReclamo> {
  const { ammesso, assente, degradato } = await caricamentiReclamabili(
    supabase,
    [percorso],
    operazione,
  )
  return { ammesso, assente, degradato }
}

/**
 * Collega alla pratica che li ha appena reclamati TUTTI gli oggetti insieme: da qui in
 * avanti non sono più in sospeso, e non sono più reclamabili da nessun'altra.
 *
 * Best-effort per costruzione — la pratica è già scritta e non si torna indietro per
 * questo — ma **si verifica lo STATO, non l'intenzione**: `.select()` dopo l'`update`
 * dice quante righe sono state toccate davvero, perché un `update` che non trova
 * niente NON è un errore per PostgREST e passerebbe in silenzio.
 *
 * ── PERCHÉ UN SOLO `update`, E COSA CAMBIA NEL LOG ─────────────────────────
 *
 * Con una chiamata per faccia il fronte può collegarsi e il retro no. Il danno è
 * doppio: resta una pratica MEZZA documentata — la spazzata toglie il retro entro
 * {@link ORE_CARICAMENTO_IN_SOSPESO} ore mentre la pratica lo nomina ancora — e
 * restano DUE righe di log scoordinate con lo stesso `entita_id`, una delle quali
 * magari non c'è affatto perché quella chiamata era riuscita. Chi legge `app_log` non
 * ha modo di ricomporle: non sa quante facce ci si aspettava.
 *
 * Con un `.in(...)` solo il fallimento parziale smette di essere una race e diventa
 * un'aritmetica: **una** riga di livello `error`, con `n_attesi` e `n_collegati`. Da
 * quei due numeri si legge tutto — quante ne mancano e se ne manca UNA o TUTTE — senza
 * mai nominare un percorso, che è la chiave con cui si firma la fotografia di un
 * documento d'identità. L'`entita_id` è un uuid, che `redact()` lascia passare per
 * forma, ed è ciò che rende il guasto riparabile.
 */
export async function collegaCaricamenti(
  supabase: SupabaseClient,
  percorsi: string[],
  praticaId: string,
  operazione: string,
): Promise<void> {
  const { distinti, attese } = facceChieste(percorsi)
  // Nessuna faccia chiesta: non c'è nessun fatto da raccontare.
  if (attese === 0) return

  // ⚠️ LE FACCE VUOTE RESTANO NEL CONTO, e non prendono una riga di log tutta loro.
  // `attese` le include, quindi il confronto qui sotto non tornerà mai e il guasto
  // esce comunque — con l'aritmetica giusta, «1 su 2», invece che con un silenzio.
  // Una riga in più per lo stesso fatto sarebbero le due righe scoordinate che questo
  // plurale esiste per togliere.
  let errore: unknown = null
  let collegati = 0

  if (distinti.length > 0) {
    // Un `.in('percorso', [])` è un viaggio al database per non chiedere niente, e la
    // sua risposta vuota sarebbe indistinguibile da un guasto.
    const esito = await supabase
      .from(TABELLA)
      .update({ pratica_id: praticaId })
      .in('percorso', distinti)
      .is('pratica_id', null)
      // Stesso predicato del reclamo, e per la stessa ragione: un oggetto già di
      // un'anagrafica non diventa di una pratica. Senza, il `check` sui due
      // proprietari respingerebbe l'intero `update` — cioè farebbe fallire anche la
      // faccia che non c'entrava niente.
      .is('anagrafica_utente_id', null)
      .select('percorso')

    errore = esito.error
    collegati = esito.error ? 0 : percorsiDi(esito.data).length
  }

  if (!errore && collegati === attese) return

  const assente = errore ? registroAssente(errore) : false
  logEvento(
    'personale',
    assente ? 'warn' : 'error',
    {
      operazione,
      esito: assente ? 'registro-caricamenti-assente' : 'caricamento-non-collegato',
      entita_id: praticaId,
      error_code: codiceDi(errore),
      n_attesi: attese,
      n_collegati: collegati,
      msg: assente
        ? `${operazione}: il registro ${TABELLA} non ha su questo database la tabella o la colonna attesa, nessun collegamento da scrivere`
        : // I due numeri stanno nei campi comunque; qui cambia la FRASE, perché chi
          // legge `app_log` alle tre di notte non deve fare l'aritmetica per capire che
          // il documento era uno solo. «0 scansioni su 1 risultano collegate» era una
          // frase al plurale su un oggetto solo, ed è peggiorata proprio per l'unico
          // chiamante che questa forma ha in produzione.
          attese === 1
          ? `${operazione}: la scansione non risulta collegata alla pratica; la spazzata la toglierà entro ${ORE_CARICAMENTO_IN_SOSPESO} ore mentre la pratica la nomina ancora`
          : `${operazione}: ${collegati} scansioni su ${attese} risultano collegate alla pratica; la spazzata toglierà le altre entro ${ORE_CARICAMENTO_IN_SOSPESO} ore mentre la pratica le nomina ancora`,
    },
    errore ?? undefined,
  )
}

/**
 * La forma a un percorso solo, per chi ne ha ancora uno solo da collegare.
 *
 * Delega, come `caricamentoReclamabile`: il log che ne esce è lo stesso, con
 * `n_attesi: 1`.
 */
export async function collegaCaricamento(
  supabase: SupabaseClient,
  percorso: string,
  praticaId: string,
  operazione: string,
): Promise<void> {
  await collegaCaricamenti(supabase, [percorso], praticaId, operazione)
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
      // ⚠️ IL SECONDO PROPRIETARIO VA GUARDATO, e questa riga è la differenza fra una
      // pulizia e una perdita di dati. Dal 12/08/2026 un oggetto può appartenere a
      // un'ANAGRAFICA invece che a una pratica (la porta admin, dove nessuna pratica
      // esiste): quella riga ha `pratica_id is null` ed è a tutti gli effetti di
      // qualcuno. Senza questo predicato la spazzata toglierebbe dal bucket, entro 24
      // ore, il documento d'identità di una dipendente in servizio, mentre
      // `anagrafica_personale` continua a nominarlo — il fascicolo punterebbe a un
      // file che non c'è. L'indice parziale in produzione conosce già entrambe le
      // colonne (`where pratica_id is null and anagrafica_utente_id is null`), ma un
      // indice non filtra: filtra la query.
      .is('anagrafica_utente_id', null)
      .lt('caricato_il', soglia)
      // Le più vecchie per prime: se il tetto taglia, taglia le meno in ritardo.
      .order('caricato_il', { ascending: true })
      .limit(tetto)

    if (error) {
      // Su un database che non conosce ancora il secondo proprietario si prende
      // `42703` e non si spazza NIENTE. È il verso giusto in cui sbagliare: «non
      // spazzare» costa un po' di spazio nel bucket, «spazzare senza guardare il
      // secondo proprietario» costa la carta d'identità di una dipendente.
      const assente = registroAssente(error)
      logEvento('gdpr', assente ? 'warn' : 'error', {
        operazione,
        esito: assente ? 'registro-caricamenti-assente' : 'spazzata-lettura-fallita',
        bucket: BUCKET_DOCUMENTI_PERSONALE,
        error_code: codiceDi(error),
        msg: assente
          ? `${operazione}: il registro ${TABELLA} non ha su questo database la tabella o la colonna attesa, nessuna spazzata. Applicare le migrazioni ${MIGRAZIONI_DEL_REGISTRO}`
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
