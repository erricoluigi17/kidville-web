/**
 * IL PRECOMPILATO — tutto ciò che l'app SA GIÀ, letto una volta sola.
 *
 * `docs/prestampati/README.md` lo dice in una riga: «un campo chiesto una volta non si
 * richiede mai più». Nome, cognome, nascita, codice fiscale, sezione, sede, dati dell'ente
 * gestore, genitori e anno scolastico non compaiono in nessuno dei diciassette moduli:
 * arrivano da qui. È la differenza fra digitalizzare un modulo e digitalizzare la
 * segreteria — un modulo che richiede alla madre la data di nascita di suo figlio, che la
 * scuola ha in archivio da tre anni, è un modulo che si compila sul telefono e si
 * abbandona a metà.
 *
 * ─── TRE COSE CHE QUESTO FILE NON FA, ED È DELIBERATO ───────────────────────────
 *
 * 1. **Non decide chi può.** Il gate è `requireParentOfStudent`, che questo file CHIAMA:
 *    una difesa sola, in un posto solo. Vedi il blocco «il cancello» qui sotto.
 * 2. **Non inventa.** Un dato che manca resta `null` e il modello omette la riga (regola
 *    2 dei modelli: mai «N.D.», mai una riga vuota che sembri un valore). L'unico posto in
 *    cui l'assenza diventa un rifiuto è il modello, non qui.
 * 3. **Non legge i dati sanitari.** `allergies`, `allergeni` e `note_mediche` NON sono
 *    nella `select`, benché il README li elenchi fra il nucleo comune: nessuno dei
 *    diciassette modelli li consuma da qui (il n. 49 costruisce le proprie righe di
 *    sezione per conto suo), e caricarli «perché un giorno serviranno» significherebbe far
 *    passare dati dell'art. 9 di un minore dentro ogni singola generazione — comprese le
 *    quindici che non c'entrano niente. Ciò che non si legge non si può perdere.
 *
 * ─── NIENTE DATI PERSONALI NEI LOG ──────────────────────────────────────────────
 *
 * Le righe di questo file portano uuid, codici PostgREST e conteggi. Mai un nome, mai un
 * codice fiscale, mai un indirizzo: `redact` è a lista bianca e li scarterebbe comunque,
 * ma il punto è non scriverli.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { firstEmail } from '@/lib/auth/parent-identity'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'
import { dataCivile } from '@/i18n/config'
import { eNonPiuIscritto } from '@/lib/alunni/stato'
import { parseAnagraficaSede } from '@/lib/scuole/anagrafica'
import { leggiModuleConfig } from '@/lib/settings/module-config'
import { componiIndirizzo, primoNonVuoto } from '@/lib/fatturazione/cedente'
import type { FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { logEvento } from '@/lib/logging/logger'
import type {
  AutorizzazioneNido,
  DatiAlunno,
  DatiGenitore,
  DatiPrestampato,
  DatiScuola,
  DatiSede,
  LivelloScolastico,
  RuoloGenitore,
} from '@/lib/prestampati/modelli/genitore'
import type {
  NucleoAlunno,
  NucleoScuola,
  NucleoSede,
} from '@/lib/prestampati/modelli/segreteria'

/** Colonna assente: il DB E2E della CI è un progetto separato e non è migrato. */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const codicePostgrest = (err: unknown): string | null =>
  (err as { code?: string } | null)?.code ?? null

// ─── Il risultato ───────────────────────────────────────────────────────────────

/**
 * Il precompilato di UN alunno: la forma dei modelli del genitore
 * (`DatiPrestampato`) più i pezzi che servono a chi compone un modello della segreteria e
 * a chi archivia.
 *
 * `dati` non porta `visto`, `sottoscrizioni`, `accompagnatore` e `uscita`: non sono
 * precompilato, sono la RICHIESTA — chi ha dato il visto, quale delegato, quale uscita. Li
 * aggiunge la route con lo spread, che è anche il motivo per cui questo campo è un oggetto
 * piatto e non una classe.
 *
 * ⚠️ `dati.richiedente` INVECE SÌ, quando chi chiede è la famiglia. Era lasciato alla
 * route, e lasciarcelo significava farlo rifare a ognuna: chi lo dimentica non se ne
 * accorge, perché con due tutori in anagrafica il blocco «Genitore/tutore richiedente» del
 * n. 06 sparisce in silenzio — sezione compresa — e solo il n. 09 rifiuta. È lo stesso
 * difetto che i modelli hanno appena chiuso togliendo la deduzione da `genitori[0]`,
 * riaperto un piano più in là. Qui c'è tutto il necessario in un posto solo: l'utente
 * autenticato e il ponte `parents.auth_user_id`.
 *
 * Allo sportello resta `null`, e non è un ripiego: il sottoscritto di quel foglio è il
 * genitore che sta davanti alla segretaria, non la segretaria che ha fatto login. Quello
 * lo dichiara la route, che sa chi ha davanti.
 */
export interface PrefillPrestampato {
  alunnoId: string
  /** La sede dell'alunno: ogni scrittura dichiara la sua (AGENTS.md). */
  scuolaId: string
  /** `alunni.section_id`, quando la sezione è agganciata. */
  sezioneId: string | null
  dati: DatiPrestampato
  /**
   * Il nome del legale rappresentante come sta in configurazione, oppure `null`.
   *
   * ⚠️ MISURATO IL 2026-08-14 SU PRODUZIONE, in sola lettura e sui soli nomi delle
   * chiavi: su 4 righe di `scuole`, **una** ha un `config.anagrafica` e **nessuna** ha
   * `legale_rappresentante`. La specifica (§3b di `00-impaginazione.md`) dice che il nome
   * viene da lì, e quel «lì» oggi è vuoto: finché qualcuno non lo scrive nelle
   * impostazioni di sede, i sei documenti che escono dalla scuola non hanno un nome da
   * stampare sotto «IL LEGALE RAPPRESENTANTE».
   *
   * Il render RIFIUTA di generarli senza (`render.ts`), invece di produrre un certificato
   * anonimo destinato all'INPS: è l'unico posto in cui l'assenza di un dato non degrada
   * in una riga omessa. Qui il campo resta `null` e dice la verità.
   */
  legaleRappresentante: string | null
}

export type EsitoPrefill =
  | { prefill: PrefillPrestampato; user: AppUser; response?: undefined }
  | { prefill?: undefined; user?: undefined; response: NextResponse }

// ─── Le righe come arrivano da PostgREST ────────────────────────────────────────

export interface RigaAlunno {
  id: string
  nome: string | null
  cognome: string | null
  data_nascita: string | null
  birth_city: string | null
  birth_province: string | null
  codice_fiscale: string | null
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  stato: string | null
  anonimizzato_il?: string | null
  genitori_separati?: boolean | null
}

const COLONNE_ALUNNO_BASE =
  'id, nome, cognome, data_nascita, birth_city, birth_province, codice_fiscale, classe_sezione, section_id, scuola_id, stato'

/**
 * Le due colonne che il DB della CI può non avere: `anonimizzato_il` nasce con l'oblio
 * (DL-034), `genitori_separati` con la doppia firma dell'08. Chiederle in un `select` che
 * non le trova fa fallire l'INTERA lettura con `42703` — non le omette — quindi si
 * riprova senza, esattamente come fanno già `staff-identity`, `chat/delivered` e
 * `forms/degrado-sede`.
 */
const COLONNE_ALUNNO_COMPLETE = `${COLONNE_ALUNNO_BASE}, anonimizzato_il, genitori_separati`

/**
 * La riga di `sections`. ⚠️ Omonima — e diversa — dalla `RigaSezione` di
 * `modelli/segreteria.ts`, che è una riga STAMPATA dell'elenco di sezione del n. 49: qui
 * c'è la sezione, là c'è un bambino. Chi importa tutte e due le aliasi.
 */
export interface RigaSezione {
  name: string | null
  school_type: string | null
}

interface RigaSede {
  nome: string | null
  citta: string | null
  indirizzo: string | null
  config: unknown
}

interface RigaGenitore {
  id: string
  first_name: string | null
  last_name: string | null
  emails: unknown
  phone_numbers: unknown
  /** Il ponte anagrafica↔account (S6bis): è ciò che dice quale di questi ha fatto login. */
  auth_user_id: string | null
}

// ─── Il cancello ────────────────────────────────────────────────────────────────

/**
 * ⚠️ IL CONTROLLO DI PORTATA NON È SCRITTO QUI, ED È IL PUNTO.
 *
 * `requireParentOfStudent` (`src/lib/auth/require-parent.ts`) è il gate delle venti route
 * che leggono i dati di UN alunno indicato dal client, e sa già la cosa che qui si
 * sbaglierebbe: **il perimetro di un genitore è la famiglia, non la sede** (due fratelli
 * possono stare in due plessi diversi), mentre per tutti gli altri ruoli è plesso +
 * sezione assegnata (`assertAlunnoInScope`). Riscrivere quella biforcazione qui
 * significherebbe avere due copie della stessa regola di sicurezza su un documento che
 * porta dati sanitari di un minore — la forma di difetto che questo repo sa nominare:
 * *una regola valida per due strade deve vivere in un posto solo*.
 *
 * Costa un `requireUser` in più quando la route ha già gatato il RUOLO (che è un'altra
 * domanda: «questo banco può generare prestampati?»). Si paga volentieri: è lo stesso
 * prezzo che pagano già le venti route, e in cambio il precompilato non ha una porta di
 * servizio. Una route che dimenticasse il proprio gate otterrebbe comunque un rifiuto qui.
 *
 * L'utente risolto torna indietro insieme al verdetto — una chiamata sola, non due: il
 * gate legge `utenti` e i legami della famiglia, e ripeterlo per sapere «chi era» sarebbe
 * due volte lo stesso giro di query a ogni foglio generato.
 */
async function portataChiusa(
  request: Request,
  alunnoId: string,
): Promise<{ user: AppUser; response?: undefined } | { user?: undefined; response: NextResponse }> {
  const auth = await requireParentOfStudent(request, alunnoId)
  if (auth.response) return { response: auth.response }
  if (!auth.user) {
    // Non può accadere — `AuthResult` è un'unione — ma `auth.user` è opzionale nel tipo e
    // un `!` qui vorrebbe dire fidarsi di una promessa scritta altrove.
    return { response: rifiutoLettura('identità') }
  }
  return { user: auth.user }
}

// ─── La lettura ─────────────────────────────────────────────────────────────────

/**
 * Carica il precompilato di un alunno, o restituisce la risposta d'errore già pronta.
 *
 * @param request la richiesta HTTP: serve al gate, che lega l'identità alla SESSIONE e
 *   non all'header (`ALLOW_HEADER_IDENTITY`).
 * @param supabase client service-role (`createAdminClient()`): il gate applicativo è
 *   quello sopra, la RLS qui non difende niente.
 * @param oggi il giorno di emissione, per i test. In produzione è adesso, e la data
 *   CIVILE italiana — non quella del processo, che su Vercel è UTC: un certificato
 *   generato alle 00:30 porterebbe la data di ieri.
 */
export async function caricaPrefillAlunno(
  request: Request,
  supabase: SupabaseClient,
  alunnoId: string,
  opzioni: { oggi?: Date } = {},
): Promise<EsitoPrefill> {
  const portata = await portataChiusa(request, alunnoId)
  if (portata.response) return { response: portata.response }
  const user = portata.user
  // Self-service: la famiglia dal telefono. Cambia due cose e nient'altro — la frase del
  // 404 (una madre non ha una «postazione») e chi risulta sottoscrittore del foglio.
  const selfService = user.role === 'genitore'

  const alunno = await leggiAlunno(supabase, alunnoId, selfService)
  if ('errore' in alunno) return { response: alunno.errore }

  const riga = alunno.riga
  const scuolaId = riga.scuola_id?.trim()
  if (!scuolaId) {
    // Senza sede non si sa da quale carta intestata esce il foglio, e indovinarla
    // significherebbe archiviare il documento di un bambino nel plesso sbagliato in
    // silenzio (AGENTS.md: «ogni scrittura dichiara la sua sede»).
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/prefill',
      esito: 'alunno-senza-sede',
      alunno_id: alunnoId,
    })
    return {
      response: NextResponse.json(
        { error: 'Questo bambino non è associato a nessuna sede: non è possibile generare il prestampato.', codice: 'PRESTAMPATO_DATI_MANCANTI' },
        { status: 422 },
      ),
    }
  }

  const bloccato = alunnoNonStampabile(riga, alunnoId)
  if (bloccato) return { response: bloccato }

  const [sezione, sede, fiscale, famiglia] = await Promise.all([
    leggiSezione(supabase, riga.section_id),
    leggiSede(supabase, scuolaId),
    leggiFiscale(supabase, scuolaId),
    leggiGenitori(supabase, alunnoId, selfService ? user.id : null),
  ])

  if (selfService && !famiglia.richiedente && famiglia.genitori.length > 1) {
    // L'UNICA TRACCIA DI UNA DEGRADAZIONE CHE NON SI VEDE.
    //
    // La famiglia sta compilando, in anagrafica ci sono due tutori e il ponte
    // `parents.auth_user_id` non dice quale dei due ha fatto login (può accadere: il gate
    // accetta anche il legame `legame_genitori_alunni`, che non passa da `parents`). Il
    // foglio esce lo stesso — il n. 06 perde il blocco «Genitore/tutore richiedente», il
    // n. 09 rifiuta — e nessuno se ne accorge guardandolo: manca una sezione che chi legge
    // non sa di dover cercare. Con un solo genitore collegato non è un problema, perché
    // non c'è niente da dedurre, e la riga non si scrive.
    logEvento('modulistica', 'info', {
      operazione: 'prestampati/prefill',
      esito: 'richiedente-non-risolto',
      alunno_id: alunnoId,
      n: famiglia.genitori.length,
    })
  }

  const anagrafica = parseAnagraficaSede(sede?.config)
  const legaleRappresentante = leggiLegaleRappresentante(sede?.config)

  const datiSede: DatiSede = {
    scuola_nome: primoNonVuoto(anagrafica.denominazione, sede?.nome) || null,
    scuola_indirizzo: sede?.indirizzo ?? null,
    scuola_cap: anagrafica.cap,
    scuola_citta: sede?.citta ?? null,
    scuola_provincia: anagrafica.provincia,
    scuola_codice_meccanografico: anagrafica.codice_meccanografico,
    autorizzazioneNido: leggiAutorizzazioneNido(sede?.config),
  }

  const dati: DatiPrestampato = {
    alunno: componiAlunno(riga, sezione),
    genitori: famiglia.genitori,
    // `null` e non «il primo dell'elenco»: con due tutori l'ordine dell'anagrafica non
    // dice chi firma, e i modelli sanno degradare su «non lo so» — stampare il nome del
    // padre sotto la firma della madre non si vede e non si corregge.
    richiedente: famiglia.richiedente,
    sede: datiSede,
    scuola: componiScuola(anagrafica.denominazione, anagrafica.piva_cf, fiscale),
    annoScolastico: annoScolasticoCorrente(opzioni.oggi),
    dataOggi: dataCivile(opzioni.oggi ?? new Date()),
  }

  return {
    user,
    prefill: {
      alunnoId,
      scuolaId,
      sezioneId: riga.section_id?.trim() || null,
      dati,
      legaleRappresentante,
    },
  }
}

/** Il 503 di una lettura che non è riuscita: il motivo tecnico resta nel log. */
function rifiutoLettura(esito: string): NextResponse {
  return NextResponse.json(
    {
      error: `Non è stato possibile leggere i dati necessari al prestampato (${esito}). Riprova fra qualche minuto.`,
      codice: 'PRESTAMPATO_ANAGRAFICA_NON_LETTA',
    },
    { status: 503 },
  )
}

async function leggiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  selfService: boolean,
): Promise<{ riga: RigaAlunno } | { errore: NextResponse }> {
  let { data, error } = await supabase
    .from('alunni')
    .select(COLONNE_ALUNNO_COMPLETE)
    .eq('id', alunnoId)
    .maybeSingle()

  if (error && COLONNA_ASSENTE.has(codicePostgrest(error) ?? '')) {
    // Ambiente non migrato: si riprova senza le due colonne giovani. `info` e non `warn`
    // perché non è un guasto — è il DB della CI, e un `warn` per ogni lettura renderebbe
    // illeggibile il canale proprio dove servirebbe.
    logEvento('modulistica', 'info', {
      operazione: 'prestampati/prefill',
      esito: 'colonne-alunno-assenti',
      error_code: codicePostgrest(error),
    })
    ;({ data, error } = await supabase
      .from('alunni')
      .select(COLONNE_ALUNNO_BASE)
      .eq('id', alunnoId)
      .maybeSingle())
  }

  if (error) {
    // PostgREST non lancia: senza questo ramo una lettura fallita uscirebbe come «alunno
    // non trovato», cioè un guasto del database travestito da risposta di merito. I due
    // hanno rimedi opposti — «non c'è» si risolve in segreteria, «non l'ho potuto
    // leggere» riprovando.
    logEvento('modulistica', 'error', {
      operazione: 'prestampati/prefill',
      esito: 'alunno-non-letto',
      alunno_id: alunnoId,
      error_code: codicePostgrest(error),
    }, error)
    return { errore: rifiutoLettura('anagrafica') }
  }

  const riga = data as unknown as RigaAlunno | null
  if (!riga) {
    // DUE CODICI PER DUE PLATEE, e non è un doppione.
    //
    // Al banco resta `ALUNNO_NON_APRIBILE`, che l'elenco della segreteria usa già quando
    // un bambino esce dalle sedi di chi guarda: la sua frase di catalogo dice «non è più
    // nell'elenco di questa postazione: ricarica la pagina o controlla la sede
    // selezionata», ed è esatta lì.
    //
    // Non lo è per la famiglia. `caricaPrefillAlunno` serve anche il self-service, e una
    // madre col telefono in mano non ha una postazione da ricaricare né una sede da
    // controllare: le si sta dando il rimedio di qualcun altro, cioè nessun rimedio. Un
    // doppione è una seconda frase che dice la stessa cosa; queste due dicono due rimedi
    // diversi a due persone diverse.
    return {
      errore: NextResponse.json(
        selfService
          ? {
              error: 'Non troviamo più questo bambino in anagrafica.',
              codice: 'PRESTAMPATO_ALUNNO_NON_TROVATO',
            }
          : { error: 'Alunno non trovato', codice: 'ALUNNO_NON_APRIBILE' },
        { status: 404 },
      ),
    }
  }
  return { riga }
}

/**
 * I due stati in cui un prestampato NON si genera, e perché sono due rifiuti distinti.
 *
 * · **archiviato** (o comunque «non più iscritto»): il foglio uscirebbe con la sezione
 *   vuota e l'anno scolastico corrente su un bambino che quest'anno non frequenta — cioè
 *   una dichiarazione falsa su carta intestata. Il rimedio esiste ed è a un click:
 *   riportarlo fra gli iscritti.
 * · **anonimizzato** (art. 17, `anonimizzato_il` valorizzato): nome e cognome in tabella
 *   sono `CANCELLATO-xxxxxxxx`, e stamparli su un certificato sarebbe il modo peggiore di
 *   rispettare una richiesta di cancellazione. Qui NON c'è rimedio, mai, e la frase deve
 *   dirlo: mandare qualcuno a «riattivare» un bambino cancellato è mandarlo a cercare un
 *   bottone che non esiste.
 *
 * Un codice solo per i due casi direbbe la cosa sbagliata a metà delle segretarie.
 */
export function alunnoNonStampabile(riga: RigaAlunno, alunnoId: string): NextResponse | null {
  if (riga.anonimizzato_il) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'alunno-anonimizzato',
      alunno_id: alunnoId,
    })
    return NextResponse.json(
      {
        error: "L'anagrafica di questo bambino è stata cancellata su richiesta della famiglia: non è più possibile generare documenti a suo nome.",
        codice: 'PRESTAMPATO_ALUNNO_ANONIMIZZATO',
      },
      { status: 409 },
    )
  }
  if (eNonPiuIscritto(riga.stato)) {
    return NextResponse.json(
      {
        error: 'Questo bambino non è più fra gli iscritti: riportalo fra gli iscritti prima di generare un prestampato.',
        codice: 'PRESTAMPATO_ALUNNO_NON_ISCRITTO',
      },
      { status: 409 },
    )
  }
  return null
}

async function leggiSezione(
  supabase: SupabaseClient,
  sezioneId: string | null | undefined,
): Promise<RigaSezione | null> {
  const id = sezioneId?.trim()
  if (!id) return null
  const { data, error } = await supabase
    .from('sections')
    .select('name, school_type')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    // Non si ferma la generazione: senza sezione il modello omette il livello e la
    // clausola «nella sezione X», che è il degrado previsto. Ma la riga si scrive: il
    // livello è l'unica cosa che distingue il certificato del nido da quello
    // dell'infanzia, e un certificato che perde quella riga per un guasto di lettura è
    // indistinguibile da uno che la perde perché il bambino non ha sezione.
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'sezione-non-letta',
      error_code: codicePostgrest(error),
    }, error)
    return null
  }
  return (data as unknown as RigaSezione | null) ?? null
}

/**
 * La sede, con lo stesso ripiego di `admin/protocolli/genera-documento`: `scuole` prima,
 * `schools` poi. Non è ridondanza — sono due tabelle che convivono da prima del
 * multi-sede, e una carta intestata vuota è un documento che nessun ente accetta.
 */
async function leggiSede(supabase: SupabaseClient, scuolaId: string): Promise<RigaSede | null> {
  const { data, error } = await supabase
    .from('scuole')
    .select('nome, citta, indirizzo, config')
    .eq('id', scuolaId)
    .maybeSingle()
  if (error) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'sede-non-letta',
      scuola_id: scuolaId,
      error_code: codicePostgrest(error),
    }, error)
  }
  const riga = (data as unknown as RigaSede | null) ?? null
  if (riga) return riga

  const { data: fallback, error: errFallback } = await supabase
    .from('schools')
    .select('nome, citta, indirizzo')
    .eq('id', scuolaId)
    .maybeSingle()
  if (errFallback) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'sede-ripiego-non-letto',
      scuola_id: scuolaId,
      error_code: codicePostgrest(errFallback),
    }, errFallback)
    return null
  }
  const riga2 = fallback as unknown as Omit<RigaSede, 'config'> | null
  return riga2 ? { ...riga2, config: null } : null
}

/**
 * L'anagrafica di CHI EMETTE, da `admin_settings.fiscale_config` — la stessa fonte delle
 * ricevute e della fattura elettronica (`datiStruttura`, `cedenteDaConfig`).
 *
 * ⚠️ NON si chiama `datiStruttura()`, che pure comporrebbe gli stessi campi: quella
 * funzione, se denominazione o P.IVA mancano, emette un `logEvento('fiscale','error')` —
 * giusto per una fattura, sbagliato qui. Su tre sedi senza dati fiscali, generare un
 * permesso di uscita anticipata accenderebbe un allarme del canale FATTURAZIONE a ogni
 * clic, e un canale che suona per una cosa che non c'entra è un canale che si impara a
 * ignorare. Qui l'assenza fa omettere le righe dell'ente gestore, che è il degrado
 * previsto per i due soli modelli che le stampano.
 */
async function leggiFiscale(
  supabase: SupabaseClient,
  scuolaId: string,
): Promise<Partial<FiscaleConfig>> {
  const esito = await leggiModuleConfig(supabase, 'fiscale_config', scuolaId)
  // `leggiModuleConfig` logga già il proprio `warn` sulla lettura fallita (canale
  // `config`), con nome della colonna e sede: raddoppiarlo qui non aggiungerebbe niente.
  //
  // Il cast è quello che usano già le quattro letture di `fiscale_config` in `src/`
  // (ricevute, attestazione, ordini fornitore): il parametro di tipo di
  // `leggiModuleConfig` pretende un `Record<string, unknown>` e `FiscaleConfig` è
  // un'interfaccia, che non lo soddisfa. Il JSONB resta comunque non tipizzato dal
  // database: ciò che protegge dal valore inatteso non è il tipo, è il degrado di
  // `componiScuola` — ogni campo assente fa sparire la sua riga.
  return esito.config as Partial<FiscaleConfig>
}

/** I genitori del bambino, e — nel self-service — quale dei due sta compilando. */
interface Famiglia {
  genitori: DatiGenitore[]
  richiedente: DatiGenitore | null
}

const NESSUNA_FAMIGLIA: Famiglia = { genitori: [], richiedente: null }

/**
 * @param accountRichiedente l'id dell'account di chi ha fatto login, **solo** quando è un
 *   genitore: è ciò che si confronta con `parents.auth_user_id`. `null` allo sportello,
 *   dove chi ha fatto login non è chi sottoscrive.
 */
async function leggiGenitori(
  supabase: SupabaseClient,
  alunnoId: string,
  accountRichiedente: string | null,
): Promise<Famiglia> {
  // `is_primary` NON si legge: la colonna esiste, ma qui non decide niente — il
  // sottoscrittore lo dice il ponte `auth_user_id`, cioè chi ha davvero fatto login, non
  // chi in anagrafica è segnato come referente. Selezionare un campo per non usarlo è, in
  // un file che si vanta di non leggere i dati sanitari, la stessa disciplina rotta.
  const { data: legami, error: errLegami } = await supabase
    .from('student_parents')
    .select('parent_id, relation_type')
    .eq('student_id', alunnoId)
  if (errLegami) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'genitori-non-letti',
      alunno_id: alunnoId,
      error_code: codicePostgrest(errLegami),
    }, errLegami)
    return NESSUNA_FAMIGLIA
  }

  const righe = (legami ?? []) as { parent_id?: unknown; relation_type?: unknown }[]
  const ruoli = new Map<string, RuoloGenitore | null>()
  for (const r of righe) {
    if (typeof r.parent_id === 'string') ruoli.set(r.parent_id, ruoloDaRelazione(r.relation_type))
  }
  if (ruoli.size === 0) return NESSUNA_FAMIGLIA

  const { data: anagrafiche, error: errAnagrafiche } = await supabase
    .from('parents')
    .select('id, first_name, last_name, emails, phone_numbers, auth_user_id')
    .in('id', [...ruoli.keys()])
  if (errAnagrafiche) {
    logEvento('modulistica', 'warn', {
      operazione: 'prestampati/prefill',
      esito: 'anagrafiche-genitori-non-lette',
      alunno_id: alunnoId,
      n: ruoli.size,
      error_code: codicePostgrest(errAnagrafiche),
    }, errAnagrafiche)
    return NESSUNA_FAMIGLIA
  }

  const out: DatiGenitore[] = []
  let richiedente: DatiGenitore | null = null
  for (const riga of (anagrafiche ?? []) as unknown as RigaGenitore[]) {
    const nomeCompleto = [riga.last_name, riga.first_name]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(' ')
    if (!nomeCompleto) continue
    const genitore: DatiGenitore = {
      nomeCompleto,
      ruolo: ruoli.get(riga.id) ?? null,
      telefono: primoTelefono(riga.phone_numbers),
      email: firstEmail(riga.emails),
    }
    out.push(genitore)
    // Lo stesso oggetto, non una copia: sotto l'elenco viene ordinato, e un clone si
    // scollerebbe dalla riga che il foglio stampa.
    if (accountRichiedente && riga.auth_user_id === accountRichiedente) richiedente = genitore
  }
  // Ordinamento stabile per cognome e nome: l'ordine in cui PostgREST restituisce le
  // righe non è garantito, e due generazioni dello stesso foglio a dieci minuti di
  // distanza non devono elencare i due tutori in ordine diverso. ⚠️ Questo NON dice chi
  // firma: il firmatario è `richiedente`, che qui viene dal ponte `auth_user_id`.
  out.sort((a, b) => a.nomeCompleto.localeCompare(b.nomeCompleto, 'it', { sensitivity: 'base' }))
  return { genitori: out, richiedente }
}

// ─── Composizione ───────────────────────────────────────────────────────────────
//
// ⚠️ LE DECISIONI PURE SONO ESPORTATE, e non «per il test».
//
// Sono sei — `alunnoNonStampabile` più su, e le cinque qui sotto — e ognuna decide qualcosa
// che finisce STAMPATO su un atto: «madre» o «tutore» accanto al nome di chi firma, «Nido»
// o niente certificato per l'INPS, «Cittàfinta (XX)» o «Cittàfinta» quando la provincia
// manca, un 409 che dice «riportalo fra gli iscritti» invece di «è stato cancellato».
// Nessuna fa I/O, quindi ognuna è verificabile per conto suo; tenerle private significava
// che l'unico modo di provarle era montare Supabase, cioè non provarle affatto — e una
// funzione che nessuno misura può cambiare comportamento col gate verde.
//
// Restano dettagli di questo modulo: non le importa nessun'altra parte del repo, e il
// giorno in cui una serve altrove va spostata, non copiata. `primoTelefono` non è fra
// loro, e la differenza è che non decide niente: prende la prima voce di un array.

/**
 * `parents.phone_numbers` è un array Postgres: si prende la prima voce non vuota.
 *
 * ⚠️ Vale per i TELEFONI e basta. Per le email c'è `firstEmail()`
 * (`src/lib/auth/parent-identity.ts`), che pretende una `@` e che questo file usa: una
 * copia più permissiva scriveva «Email di riferimento: n/d» sulla SCHEDA SANITARIA, cioè
 * sul foglio che si legge quando un bambino sta male. Un numero di telefono non ha un
 * carattere che lo renda riconoscibile, un indirizzo sì, e chi ce l'ha lo usi.
 */
function primoTelefono(valore: unknown): string | null {
  if (!Array.isArray(valore)) return null
  for (const v of valore) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/**
 * `student_parents.relation_type` usa le voci inglesi dell'ETL (`mother`/`father`), il
 * PDF quelle italiane. Tutto ciò che non è una delle due è `tutore`: nonni, affidatari e
 * l'assenza del dato: sul foglio «tutore» è vero per tutti e tre, mentre indovinare
 * «padre» su una nonna è un errore che si legge.
 */
export function ruoloDaRelazione(relazione: unknown): RuoloGenitore | null {
  const r = typeof relazione === 'string' ? relazione.trim().toLowerCase() : ''
  if (r === 'mother' || r === 'madre') return 'madre'
  if (r === 'father' || r === 'padre') return 'padre'
  return r ? 'tutore' : null
}

/** I tre gradi del repo (`sections.school_type`); qualunque altra cosa vale «ignoto». */
export function livelloDaSezione(schoolType: string | null | undefined): LivelloScolastico | null {
  const t = schoolType?.trim().toLowerCase()
  return t === 'nido' || t === 'infanzia' || t === 'primaria' ? t : null
}

export function componiAlunno(riga: RigaAlunno, sezione: RigaSezione | null): DatiAlunno {
  const luogo = [riga.birth_city?.trim(), riga.birth_province?.trim()]
    .filter(Boolean)
  return {
    nome: riga.nome?.trim() ?? '',
    cognome: riga.cognome?.trim() ?? '',
    dataNascita: riga.data_nascita ?? null,
    // «Cittàfinta (XX)», e se la provincia manca resta la sola città: mai una parentesi
    // vuota, che su un certificato si legge come un dato perso.
    luogoNascita: luogo.length === 2 ? `${luogo[0]} (${luogo[1]})` : (luogo[0] ?? null),
    codiceFiscale: riga.codice_fiscale?.trim() || null,
    // `classe_sezione` è ciò che si STAMPA; `sections.name` è la stessa cosa vista dalla
    // tabella delle sezioni. Vince la prima, che è la colonna che la segreteria corregge.
    sezione: riga.classe_sezione?.trim() || sezione?.name?.trim() || null,
    livello: livelloDaSezione(sezione?.school_type),
    genitoriSeparati: riga.genitori_separati ?? null,
  }
}

/**
 * L'ente gestore: `scuole.config.anagrafica` prima, `admin_settings.fiscale_config` poi.
 *
 * L'ordine non è casuale ed è quello che la specifica chiede («mai cablati nel codice:
 * vengono da `scuole.config.anagrafica`»), ma il ripiego non è teorico: misurato il
 * 2026-08-14, `config.anagrafica` esiste su UNA sede su quattro, mentre `fiscale_config`
 * porta denominazione, P.IVA e domicilio fiscale su tre righe. Senza il ripiego, il
 * certificato per il Bonus Nido uscirebbe senza i dati identificativi della struttura —
 * cioè senza la parte che l'INPS legge.
 */
export function componiScuola(
  denominazioneSede: string | null | undefined,
  pivaSede: string | null | undefined,
  fiscale: Partial<FiscaleConfig>,
): DatiScuola {
  const sedeLegale = [
    componiIndirizzo(fiscale.indirizzo, fiscale.numero_civico),
    [fiscale.cap, fiscale.comune].map((p) => p?.trim()).filter(Boolean).join(' '),
    fiscale.provincia?.trim() ? `(${fiscale.provincia.trim().toUpperCase()})` : '',
  ]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' — ')
  return {
    ragioneSociale: primoNonVuoto(denominazioneSede, fiscale.denominazione) || null,
    piva: primoNonVuoto(pivaSede, fiscale.piva, fiscale.codice_fiscale) || null,
    sedeLegale: sedeLegale || null,
    // Il nome di chi firma NON sta qui: lo porta `PrefillPrestampato.legaleRappresentante`
    // e lo consuma il blocco firma. Duplicarlo dentro `DatiScuola` vorrebbe dire due
    // sorgenti per lo stesso nome sullo stesso foglio.
    legaleRappresentante: null,
  }
}

/**
 * Il legale rappresentante da `scuole.config.anagrafica.legale_rappresentante`.
 *
 * Si leggeva a mano perché `zAnagraficaSede` non dichiarava questa chiave e `zod` la
 * SCARTAVA in silenzio; la lettura additiva doveva reggere «finché la decisione non la
 * prende chi possiede quel pannello». 🔴 QUELLA ATTESA È COSTATA: lo schema non è solo
 * un filtro in lettura — `normalizzaAnagraficaSede` ricostruisce l'oggetto dai campi che
 * conosce, quindi una chiave fuori schema non era «ignorata», era CANCELLATA al primo
 * salvataggio dell'anagrafica. Il campo non è mai potuto esistere, e la Segreteria si è
 * vista rifiutare cinque prestampati su sei con l'istruzione di compilare qualcosa che
 * non c'era.
 *
 * Dal 2026-08-15 la chiave sta in `zAnagraficaSede` e il campo in Impostazioni → Sede &
 * Intestazione. Questa funzione resta a lettura diretta perché è ciò che serve qui — una
 * stringa, o `null` — e perché non deve dipendere dalla normalizzazione di un form.
 */
function leggiLegaleRappresentante(config: unknown): string | null {
  return stringaDaAnagrafica(config, 'legale_rappresentante')
}

/**
 * Gli estremi dell'autorizzazione comunale al funzionamento del nido (n. 28), da
 * `scuole.config.anagrafica.autorizzazione_nido`.
 *
 * ⚠️ MISURATO IL 2026-08-14: quella chiave oggi non esiste su nessuna delle quattro
 * righe di `scuole`, e sono tre autorizzazioni diverse — numero, data e Comune diversi
 * per Giugliano, Aversa e Cesa. Finché restano fuori dalla configurazione, il modello del
 * Bonus Asilo Nido RIFIUTA di emettere il certificato, ed è la cosa giusta: un modulo
 * INPS con «N. ______ del ______» viene respinto allo sportello, e la famiglia lo scopre
 * in coda.
 *
 * Si legge lo stesso, invece di scrivere `null` fisso, perché il giorno in cui qualcuno
 * salva quei tre valori nelle impostazioni di sede il certificato deve cominciare a
 * uscire — senza una migrazione e senza toccare questo file.
 *
 * Dal 2026-08-15 quel giorno è possibile: i tre campi stanno in Impostazioni → Sede &
 * Intestazione. Restano da COMPILARE, sede per sede, e sono tre autorizzazioni diverse:
 * finché non lo si fa, il rifiuto qui sopra resta quello giusto.
 */
export function leggiAutorizzazioneNido(config: unknown): AutorizzazioneNido | null {
  const anagrafica = (config as { anagrafica?: unknown } | null | undefined)?.anagrafica
  const grezzo = (anagrafica as { autorizzazione_nido?: unknown } | null | undefined)?.autorizzazione_nido
  if (!grezzo || typeof grezzo !== 'object') return null
  const voce = grezzo as Record<string, unknown>
  const stringa = (chiave: string): string | null => {
    const v = voce[chiave]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const numero = stringa('numero')
  const data = stringa('data')
  const comune = stringa('comune')
  // Nessuno dei tre pezzi = nessuna autorizzazione, non un oggetto di `null` che il
  // modello dovrebbe imparare a riconoscere.
  return numero || data || comune ? { numero, data, comune } : null
}

/** Una stringa non vuota da `config.anagrafica`, o `null`. Il JSONB non è tipizzato: mai `throw`. */
function stringaDaAnagrafica(config: unknown, chiave: string): string | null {
  const anagrafica = (config as { anagrafica?: unknown } | null | undefined)?.anagrafica
  const valore = (anagrafica as Record<string, unknown> | null | undefined)?.[chiave]
  return typeof valore === 'string' && valore.trim() ? valore.trim() : null
}

// ─── Adattatori per i modelli della segreteria ──────────────────────────────────
//
// I nove modelli di `modelli/segreteria.ts` hanno un nucleo proprio, con gli stessi dati e
// nomi diversi (`NucleoAlunno`, `NucleoSede`, `NucleoScuola`). Finché i due contratti non
// si uniscono, la conversione vive qui — in tre funzioni pure di quattro righe — invece
// che dentro ognuna delle route che comporranno quei nove.

export function nucleoAlunno(prefill: PrefillPrestampato): NucleoAlunno {
  const a = prefill.dati.alunno
  return {
    cognome: a.cognome,
    nome: a.nome,
    dataNascita: a.dataNascita ?? null,
    luogoNascita: a.luogoNascita ?? null,
    codiceFiscale: a.codiceFiscale ?? null,
    sezione: a.sezione ?? null,
  }
}

export function nucleoSede(prefill: PrefillPrestampato): NucleoSede {
  const s = prefill.dati.sede
  return {
    nome: s.scuola_nome ?? null,
    // Il telefono della sede sta in `scuole.config.anagrafica.telefono`, che
    // `parseAnagraficaSede` legge ma `SedeCertificato` non porta: l'intestazione dei
    // certificati non lo stampa. Chi ne ha bisogno (il tagliando del n. 31) lo passa a
    // mano finché i due nuclei restano due.
    telefono: null,
    codiceMeccanografico: s.scuola_codice_meccanografico ?? null,
  }
}

export function nucleoScuola(prefill: PrefillPrestampato): NucleoScuola {
  const s = prefill.dati.scuola
  return {
    ragioneSociale: s.ragioneSociale ?? null,
    piva: s.piva ?? null,
    sedeLegale: s.sedeLegale ?? null,
    // ⚠️ `null`, E NON IL CODICE DELLA SEDE.
    //
    // `NucleoScuola.codiciMeccanografici` dichiara «tutti i codici della cooperativa (n.
    // 47): le sedi ne hanno più d'uno». Metterci quello della sede dell'alunno riempiva un
    // campo al plurale con un valore su tre, su un certificato di servizio che va a un
    // ente: un dato più stretto del proprio significato non si vede, perché ha l'aria di
    // essere completo — mentre una riga assente si vede subito.
    //
    // Oggi quell'elenco NON ha una fonte: `scuole.config.anagrafica` porta il codice della
    // singola sede, e nessuna riga di configurazione tiene insieme i tre. Finché non ce
    // l'ha, la riga sparisce — che è la disciplina di tutto il resto di questo file. Il
    // giorno in cui qualcuno la scriverà in configurazione, si legge qui e basta.
    codiciMeccanografici: null,
  }
}
