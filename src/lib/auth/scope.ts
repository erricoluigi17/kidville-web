import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from './require-staff'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from './rifiuto-sede'

// =============================================================================
// Scoping per tenant (plesso) e per classe delle funzioni docente.
//
// Modello (decisione di prodotto, PRD §3/§12):
//  - educator   → SOLO le sezioni assegnate (utenti_sezioni), nel proprio plesso.
//  - segreteria → TUTTE le classi del PROPRIO plesso (utenti.scuola_id).
//  - coordinator→ come oggi: tutte le classi del proprio plesso.
//  - admin      → Direzione: tutti i plessi in utenti_scuole (fallback scuola_id).
// Mai cross-tenant. Da usare SEMPRE dopo `requireDocente` (che verifica il ruolo
// ma non lo scope). Le funzioni "assert*" tornano una NextResponse 4xx pronta
// oppure null se l'accesso è consentito.
// =============================================================================

/**
 * Codici che significano «questa TABELLA non esiste in questo database» —
 * `42P01` (Postgres) e `PGRST205` (PostgREST non la trova nella schema cache).
 * NON ci sono i codici di COLONNA (`42703`, `PGRST204`): su `utenti_scuole` si
 * legge `scuola_id`, che sta nel baseline. Lì un errore di colonna non è «CI non
 * migrata», è la colonna sparita — e allora si nega.
 */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

/**
 * Plessi (schools.id) su cui l'utente può operare.
 *
 * ⚠️ FAIL-CLOSED, e non è una precauzione teorica. PostgREST non lancia: fino al
 * 2026-07-31 `{ error }` qui non veniva guardato, quindi una lettura fallita del
 * ponte lasciava `data` a null, `extra` a `[]` e l'admin di tre sedi diventava
 * di UNA — la primaria. Da lì `resolveScuolaScrittura` imboccava il ramo
 * `accessibili.length === 1` e archiviava il dato a Giugliano **senza il 400 e
 * senza il warn**: cioè il difetto che l'audit aveva appena rimosso, rientrato
 * da una porta laterale. Restava solo la riga `db error` del fetch strumentato,
 * che dice «PostgREST ha risposto male su utenti_scuole» e non «una scrittura è
 * finita nel plesso sbagliato».
 *
 * Un errore di lettura non è un permesso: se non si sa quali sedi ha l'utente,
 * non ne ha nessuna. Tutti i chiamanti trattano lo scope vuoto come diniego
 * (403 sulle scritture, elenco vuoto sulle letture), quindi il contratto regge
 * senza cambiare la firma su 50 file.
 *
 * Unica deroga: la tabella ponte ASSENTE per intero. Dove `utenti_scuole` non
 * esiste nessuno è multi-plesso, quindi la sede primaria è la verità completa e
 * non un restringimento silenzioso — ma resta un `warn` persistito, perché in
 * produzione quella tabella c'è e la sua sparizione è un incidente.
 */
export async function scuoleDiUtente(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const own = user.scuola_id ? [user.scuola_id] : []
  // Solo la Direzione (admin) può essere multi-plesso via utenti_scuole.
  if (user.role !== 'admin') return own
  const { data, error } = await supabase
    .from('utenti_scuole')
    .select('scuola_id')
    .eq('utente_id', user.id)
  if (error) {
    const codice = (error as { code?: string }).code ?? ''
    if (TABELLA_ASSENTE.has(codice)) {
      logEvento('auth', 'warn', {
        tipo: 'sedi-utente-ponte-assente', azione: 'scuoleDiUtente',
        utente: user.id, ruolo: user.role,
      }, error)
      return own
    }
    logEvento('auth', 'error', {
      tipo: 'sedi-utente-non-risolte', azione: 'scuoleDiUtente',
      utente: user.id, ruolo: user.role,
    }, error)
    return []
  }
  const extra = (data ?? []).map((r) => r.scuola_id as string)
  const set = new Set<string>([...own, ...extra])
  return [...set]
}

// =============================================================================
// Sedi attive (selezione del SedeSelector → cookie). La selezione è una
// preferenza UI: viene SEMPRE ri-validata server-side contro le sedi accessibili
// (scuoleDiUtente), quindi manometterla non dà accesso a plessi non propri.
// =============================================================================

const COOKIE_SEDI = 'sedi_attive'

/**
 * La forma su cui si CONFRONTANO due uuid di sede.
 *
 * ⚠️ Non è un vezzo estetico. In Postgres `uuid` è un TIPO, non una stringa:
 * `'AAAAAAAA-…'` e `'aaaaaaaa-…'` sono lo STESSO valore, e
 * `where scuola_id = 'AAAAAAAA-…'` trova la riga. In JavaScript sono due stringhe
 * diverse, e `Set.has` — il modo in cui questo modulo ha sempre confrontato le
 * sedi — risponde `false`.
 *
 * Misurato dal collaudo di sicurezza del 2026-07-31 sui dati veri: la segreteria
 * che dichiarava **la propria** sede in maiuscolo riceveva **403 «Sede non
 * accessibile»** e accendeva il warn `sede-scrittura-fuori-scope`. Due danni, e
 * il secondo è quello che dura: una scrittura legittima negata — la si vede, ci
 * si accorge — e un contatore nato come SEGNALE DI SICUREZZA riempito di falsi
 * positivi, che nessuno vede finché non serve.
 *
 * Normalizzare è un CONFRONTO, non un permesso: una sede **altrui** in maiuscolo
 * resta negata, ed è il controllo negativo che sta accanto a ognuno di questi
 * casi in `__tests__/lib/auth/scope.test.ts`.
 */
function formaConfronto(id: string): string {
  return id.trim().toLowerCase()
}

/**
 * Indice `forma di confronto → valore CANONICO` delle sedi accessibili.
 *
 * Ciò che esce da questo modulo è SEMPRE il valore che arriva dal database, mai
 * la stringa arrivata dal client. Le 65 chiamate a `resolveScuolaScrittura` con
 * quel valore ci scrivono la colonna `scuola_id` — e Postgres normalizzerebbe da
 * sé — ma diverse ci fanno anche un `===` con un altro uuid già letto: lì un
 * `'AAAAAAAA-…'` di ritorno sarebbe un confronto falso, cioè lo stesso difetto
 * spostato di un metro.
 */
function indiceSedi(accessibili: string[]): Map<string, string> {
  const indice = new Map<string, string>()
  for (const id of accessibili) indice.set(formaConfronto(id), id)
  return indice
}

/** Le sedi richieste dal client che sono davvero accessibili, in forma canonica. */
function sediInScope(richieste: string[], indice: Map<string, string>): string[] {
  const dentro: string[] = []
  for (const id of richieste) {
    const canonica = indice.get(formaConfronto(id))
    if (canonica !== undefined) dentro.push(canonica)
  }
  return dentro
}

/**
 * Le sedi selezionate nel SedeSelector, come le manda il client.
 *
 * Restituisce i valori GREZZI (non canonici): sono quelli che finiscono nel log
 * del diniego, e lì serve sapere che cosa è arrivato davvero. Deduplica però per
 * forma di confronto, perché «quali sedi hai scelto» è un insieme: senza,
 * `sedi_attive=<X>,<X>` conterebbe due selezioni e una scrittura perfettamente
 * determinata cadrebbe nel ramo dell'ambiguità (400).
 */
function sediDalCookie(request: NextRequest): string[] {
  // Difensivo: in test l'oggetto request può non avere `.cookies`.
  const raw = request.cookies?.get?.(COOKIE_SEDI)?.value
  if (!raw) return []
  const viste = new Set<string>()
  const sedi: string[] = []
  for (const pezzo of raw.split(',')) {
    const id = pezzo.trim()
    if (!id) continue
    const chiave = formaConfronto(id)
    if (viste.has(chiave)) continue
    viste.add(chiave)
    sedi.push(id)
  }
  return sedi
}

/**
 * LETTURE: insieme di plessi su cui filtrare (`scuola_id IN (...)`). Sono le sedi
 * selezionate nel SedeSelector (cookie) INTERSECATE con quelle accessibili.
 *
 * Cookie ASSENTE → tutte le accessibili (nessuna selezione = nessuna
 * restrizione). Cookie PRESENTE ma con intersezione vuota → `[]`, cioè si NEGA:
 * l'utente ha chiesto sedi che non sono (o non sono più) sue, e l'unica risposta
 * onesta è «niente», non «allora eccoti tutto». Fino al 2026-07-31 questo era
 * l'unico punto del modulo in cui il vuoto ALLARGAVA invece di restringere, e
 * mascherava l'unico segnale che dice «questo utente ha perso l'accesso a una
 * sede» oppure «qualcuno ha manomesso il cookie»: per questo ora lo si logga.
 *
 * L'intersezione è **senza distinzione di maiuscole** (vedi `formaConfronto`) e
 * restituisce la forma CANONICA del database: prima un cookie in maiuscolo
 * svuotava lo scope — cioè negava — *e* accendeva quel segnale con un falso
 * positivo. Lo stesso confronto sbagliato che sulla scrittura valeva un 403.
 */
export async function resolveScuoleAttive(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const accessibili = await scuoleDiUtente(supabase, user)
  const selezionate = sediDalCookie(request)
  if (selezionate.length === 0) return accessibili
  const inter = sediInScope(selezionate, indiceSedi(accessibili))
  if (inter.length === 0) {
    // `warn` → persistito: nessuna sede selezionata è accessibile. Solo uuid
    // utente, ruolo e conteggi: nessun dato di minori, nessuna sede in chiaro.
    logEvento('auth', 'warn', {
      tipo: 'sedi-attive-non-accessibili', azione: 'resolveScuoleAttive',
      utente: user.id, ruolo: user.role,
      selezionate: selezionate.length, accessibili: accessibili.length,
    })
  }
  return inter
}

/**
 * SCRITTURE (create/update che settano `scuola_id`): UNA sola sede, e la sede si
 * DICHIARA. Ordine: `preferita`/body.scuola_id → l'unica sede attiva (cookie) →
 * l'unica sede accessibile. Se resta ambiguo — più sedi accessibili e nessuna
 * indicata — ritorna una NextResponse **400**.
 *
 * Il confronto fra uuid è **senza distinzione di maiuscole** (vedi
 * `formaConfronto`) e ciò che esce è sempre la forma CANONICA del database, non
 * la stringa del client.
 *
 * ⚠️ NIENTE RIPIEGO SULLA SEDE PRIMARIA. Fino al 2026-07-31 qui c'era un ultimo
 * ramo `if (user.scuola_id && set.has(user.scuola_id))`, e siccome
 * `scuoleDiUtente` mette la sede primaria per PRIMA (riga 25) e `utenti.scuola_id`
 * è NOT NULL, quel ramo scattava SEMPRE: il 400 era codice morto. Effetto reale:
 * l'admin che nel SedeSelector aveva scelto Aversa+Cesa — cioè aveva tolto
 * Giugliano — si vedeva archiviare il dato **a Giugliano**, senza errore e senza
 * log. Con tre plessi la «sede primaria» non è un default sensato: è solo la
 * prima che è stata assegnata all'utente. Chi ha un solo plesso non cambia
 * comportamento (ramo `accessibili.length === 1`); chi ne ha più d'uno deve dire
 * dove sta scrivendo.
 *
 * ⚠️ E NIENTE RIPIEGO SULLA SEDE DICHIARATA MALE. Fino allo stesso giorno la
 * riga era `if (preferita && set.has(preferita)) return …`: una `preferita` NON
 * accessibile non veniva negata, veniva **dimenticata**, e la funzione tirava
 * dritto sul cookie e poi sull'unica sede accessibile. Misurato:
 * `POST /api/mensa/alternative` con la sede di Cesa fatto da un utente di Aversa
 * rispondeva **200**, con la riga scritta su **Aversa**. Idem `POST /api/gallery`.
 * Il client chiedeva un plesso, il server ne sceglieva un altro e non lo diceva a
 * nessuno.
 *
 * Il difetto era già noto e tamponato **route per route** (`news/digest/genera`
 * ci aveva messo un `if (sw.scuolaId !== scuola_id) → 403` scritto a mano), ma le
 * chiamate a questa funzione sono 65 in 54 file: un tampone su 54 non è una
 * difesa, è un promemoria. Perciò il controllo sta QUI, una volta sola.
 *
 * Da oggi: `preferita` presente e non accessibile ⇒ **403 «Sede non accessibile»**
 * + `warn` persistito. Che è anche la risposta che il caso identico riceveva già
 * in LETTURA da `restringiASedeRichiesta` (`src/lib/auth/sede-richiesta.ts`):
 * erano due risposte diverse alla stessa domanda, ora è una.
 *
 * ⚠️ E NIENTE RIPIEGO NEMMENO SUL COOKIE MANOMESSO. Dal 2026-08-01 il cookie
 * `sedi_attive` riceve lo **stesso** trattamento della sede dichiarata: se porta
 * **solo** sedi non accessibili ⇒ **403** + `warn`, invece di essere scartato in
 * silenzio e sostituito dall'«unica sede accessibile». `sedi_attive` non è
 * httpOnly e lo dichiara il suo stesso provider («il cookie NON è un segreto, il
 * server lo ri-valida SEMPRE»): ri-validare però non voleva ancora dire negare.
 * Misurato: `POST /api/tasks` con `sedi_attive=<Cesa>` da una segreteria di
 * Aversa → **201 su Aversa, senza un log**. Erano due porte per la stessa
 * stanza, chiuse a chiave diversa.
 *
 * Un cookie MISTO continua a restringere e non nega: è il suo mestiere. Nega
 * solo il cookie che non nomina **nessuna** sede propria.
 *
 * Sono tre dinieghi distinti, e vanno tenuti distinti: **400** è «non mi hai
 * detto dove» (l'operatore deve scegliere), **403** è «mi hai detto una sede che
 * non è tua» — un segnale di sicurezza, che dentro il contatore dell'ambiguità
 * sparirebbe — e i due 403 (body, cookie) hanno `tipo` diverso perché la
 * correzione è diversa: il primo è chi chiama, il secondo è una selezione stantìa
 * o manomessa nel browser.
 */
export async function resolveScuolaScrittura(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  preferita?: string | null,
): Promise<{ scuolaId?: string; response?: NextResponse }> {
  const accessibili = await scuoleDiUtente(supabase, user)
  if (accessibili.length === 0) {
    return { response: NextResponse.json({ error: 'Nessun plesso associato all\'utente' }, { status: 403 }) }
  }
  const indice = indiceSedi(accessibili)
  if (preferita) {
    const canonica = indice.get(formaConfronto(preferita))
    if (canonica !== undefined) return { scuolaId: canonica }
    // `warn` → persistito. Nel log niente dati personali: uuid, ruolo, conteggi.
    //
    // `sede_richiesta` È la sede rifiutata, e va detta. Prima non c'era, e la
    // riga in produzione si leggeva così:
    //   `… ruolo=admin sede=d53b0fbc-…(Giugliano) tipo=sede-scrittura-fuori-scope
    //      azione=resolveScuolaScrittura utente=b3d1d697-… accessibili=3`
    // dove la sede respinta era invece `e2e00000-…`. Quel `sede=` arriva dal
    // CONTESTO di richiesta — è la sede primaria di chi chiama — e chi legge
    // alle 3 di notte lo prende per la sede del tentativo: il segnale di
    // sicurezza nominava l'innocente.
    //
    // ⚠️ La nota che stava qui prima («la sede richiesta NON va in chiaro»)
    // era falsa oltre che inutile: descriveva `campi`, non la riga. `parseBody`
    // deposita il body GREZZO nel contesto, e nella riga persistita
    // `payload.body.scuola_id` si legge in chiaro da sempre — perché è un uuid,
    // e gli uuid passano la lista bianca di `redact`. La sede richiesta era già
    // leggibile: solo, per un accidente (che il dato arrivasse dal body) invece
    // che per una scelta. Un uuid di sede non è un dato personale: non è di un
    // minore, non è di una famiglia, è l'identificativo di un plesso.
    logEvento('auth', 'warn', {
      tipo: 'sede-scrittura-fuori-scope', azione: 'resolveScuolaScrittura',
      utente: user.id, ruolo: user.role,
      sede_richiesta: preferita, accessibili: accessibili.length,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  const selezionate = sediDalCookie(request)
  const attive = sediInScope(selezionate, indice)
  if (attive.length === 1) return { scuolaId: attive[0] }
  if (selezionate.length > 0 && attive.length === 0) {
    // ⚠️ IL COOKIE È MANOMETTIBILE ESATTAMENTE COME IL BODY, e fino al
    // 2026-08-01 non riceveva lo stesso trattamento: le sedi non accessibili
    // venivano scartate in SILENZIO e si tirava dritto fino a «l'unica sede
    // accessibile». Misurato: `POST /api/tasks` come segreteria di Aversa con
    // `Cookie: sedi_attive=<uuid di Cesa>` e nessuna sede nel body → **201, riga
    // scritta su Aversa**, e in `app_log` nemmeno una riga (mentre in LETTURA lo
    // stesso cookie produce regolarmente `sedi-attive-non-accessibili`).
    //
    // Non è una fuga — il dato resta nel plesso di chi scrive — ma è lo stesso
    // schema che il ciclo precedente ha appena tolto alla sede DICHIARATA: «il
    // client chiede un plesso, il server ne sceglie un altro e non lo dice a
    // nessuno». Due porte per la stessa stanza, chiuse a chiave diversa.
    //
    // `tipo` distinto da quello della lettura (`sedi-attive-non-accessibili`) e
    // da quello della sede dichiarata: `messaggio` entra nell'IMPRONTA di
    // `app_log` e `contesto` no, quindi due segnali con lo stesso `tipo` sulla
    // stessa route e nello stesso giorno collassano in UNA riga e del secondo
    // non resta niente (cfr. `__tests__/lib/logging-eventi-distinti.test.ts`).
    //
    // `sede_richiesta` solo quando il cookie ne porta UNA: due uuid concatenati
    // non sono un uuid, uscirebbero da `redact` come `[redatto:str/73]`, e un
    // campo che a volte è un dato e a volte è rumore è peggio di un campo che
    // manca. Quante fossero lo dice `selezionate`.
    logEvento('auth', 'warn', {
      tipo: 'sede-scrittura-cookie-fuori-scope', azione: 'resolveScuolaScrittura',
      utente: user.id, ruolo: user.role,
      sede_richiesta: selezionate.length === 1 ? selezionate[0] : undefined,
      selezionate: selezionate.length, accessibili: accessibili.length,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  if (accessibili.length === 1) return { scuolaId: accessibili[0] }
  // `warn` → persistito: una scrittura ambigua è un'operazione RIFIUTATA, e il
  // motivo deve essere leggibile senza risalire al corpo della richiesta.
  //
  // Qui NON c'è più `dichiarata: Boolean(preferita)`: da quando una `preferita`
  // fuori scope esce col 403 qui sopra, in questo punto `preferita` è per
  // costruzione assente e quel campo varrebbe `false` per sempre. Un campo che
  // dice sempre la stessa cosa è peggio di un campo che manca: sembra
  // un'informazione. «Era stata dichiarata una sede?» ora si legge dal `tipo`
  // della riga (`…-fuori-scope` contro `…-ambigua`).
  logEvento('auth', 'warn', {
    tipo: 'sede-scrittura-ambigua', azione: 'resolveScuolaScrittura',
    utente: user.id, ruolo: user.role,
    accessibili: accessibili.length, attive: attive.length,
  })
  return { response: rifiutoSede('SEDE_DA_SPECIFICARE') }
}

/**
 * Diniego per GUASTO, non per scope: 500 + una riga `error` che dice quale
 * verifica non è stata fatta.
 *
 * Esiste perché le sette `assert*` sbagliavano allo stesso modo in cinque punti
 * su sette: PostgREST non lancia, quindi una lettura fallita lasciava `data` a
 * null e la funzione rispondeva **404 «non trovato»** o **403 «fuori dal tuo
 * plesso»** — cioè affermava qualcosa sul dato che non aveva letto. Due danni,
 * non uno: chi riceve il 403 non sa che è un guasto, e i contatori
 * `*-fuori-sede` — che l'audit ha creato come segnale di sicurezza — si
 * riempiono di falsi positivi.
 *
 * Il messaggio è deliberatamente lo stesso per tutte: al client non serve sapere
 * QUALE tabella non si è letta (e non deve saperlo). Il `tipo` lo dice al log.
 */
function scopeNonRisolto(
  tipo: string,
  err: unknown,
  campi: Record<string, string | number | null | undefined> = {},
): NextResponse {
  logEvento('auth', 'error', { tipo, ...campi }, err)
  return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
}

/** True se l'utente ha visibilità su TUTTE le classi del proprio/i plesso/i. */
export function vedeTutteLeClassi(user: AppUser): boolean {
  return user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
}

/**
 * Filtro per SEZIONE da applicare agli ELENCHI, complemento del filtro per sede.
 *
 * Ritorna `null` per chi vede tutte le classi del proprio plesso (admin,
 * coordinator, segreteria): nessuna restrizione oltre alla sede. Per l'`educator`
 * ritorna le sole sezioni assegnate in `utenti_sezioni` — decisione di prodotto
 * del 2026-07-30, presa dal titolare: 9 educator su 10 le hanno già assegnate.
 *
 * Fail-closed: un educator senza sezioni assegnate riceve `[]`, cioè un elenco
 * vuoto. È la risposta giusta — «non ti è stata assegnata nessuna classe» — e non
 * «eccoti tutte quelle del plesso».
 *
 * Uso tipico, in AND col filtro di sede:
 * ```ts
 * const plessi = await resolveScuoleAttive(request, supabase, user)
 * let q = supabase.from('...').select('..., alunni!inner(...)').in('alunni.scuola_id', plessi)
 * const mie = await sezioniVisibili(supabase, user)
 * if (mie) q = q.in('alunni.section_id', mie)
 * ```
 */
export async function sezioniVisibili(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[] | null> {
  if (vedeTutteLeClassi(user)) return null
  return await sezioniDiUtente(supabase, user.id)
}

/**
 * Verifica che `sectionId` sia nello scope dell'utente. Per `educator` richiede
 * anche che la sezione sia assegnata (utenti_sezioni). 403/404 se fuori scope.
 */
export async function assertSezioneInScope(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!sectionId) {
    return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
  }
  const { data: section, error } = await supabase
    .from('sections')
    .select('id, scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-sezione-non-risolta', error, { utente: user.id })
  if (!section) {
    return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!section.scuola_id || !plessi.includes(section.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: classe fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!mie.includes(sectionId)) {
      return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
    }
  }
  return null
}

/**
 * Verifica che una classe identificata per NOME (es. 'Girasoli') appartenga a un
 * plesso dell'utente. Per i moduli 0-6/trasversali keyed sul nome sezione: il
 * nome viene risolto SOLO entro i plessi consentiti, così non porta mai
 * cross-tenant (i nomi sono unici solo per scuola_id). 403 se fuori scope.
 *
 * ⚠️ Da quando le sedi sono TRE il nome-classe NON è più una chiave univoca:
 * «2 ANNI» e «5 ANNI» esistono sia ad Aversa sia a Cesa. Questo assert impedisce
 * di *nominare* una classe altrui, ma non filtra le righe: chi legge alunni per
 * `classe_sezione` deve comunque restringere la query per sede
 * (`.in('scuola_id', …)`), altrimenti l'omonimia porta dentro i bambini
 * dell'altra sede. Gate e filtro, sempre entrambi.
 *
 * @param opts.soloSezioniAssegnate  per `educator` (e chiunque non veda tutte le
 *   classi del plesso, cfr. `vedeTutteLeClassi`) esige che la classe sia fra
 *   quelle assegnate in `utenti_sezioni`. Non tocca admin/coordinator/segreteria,
 *   che per progetto vedono TUTTE le classi del proprio plesso.
 */
export async function assertClasseNomeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  classeNome: string | null | undefined,
  opts?: { soloSezioniAssegnate?: boolean },
): Promise<NextResponse | null> {
  if (!classeNome) {
    return NextResponse.json({ error: 'classe (nome) obbligatoria' }, { status: 400 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) {
    return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 403 })
  }
  // Niente `.limit(1)`: con `soloSezioniAssegnate` servono TUTTE le sezioni
  // omonime dentro i propri plessi per intersecarle con quelle del docente.
  // L'insieme è comunque minuscolo (una riga per sede accessibile).
  const { data, error } = await supabase
    .from('sections')
    .select('id')
    .eq('name', classeNome)
    .in('scuola_id', plessi)
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    return scopeNonRisolto('scope-classe-non-risolta', error, { sezione: classeNome })
  }
  if (data.length === 0) {
    // `warn` → persistito: «qualcuno ha chiesto una classe che non è nei suoi
    // plessi» è un segnale di sicurezza, non rumore. Solo uuid utente, ruolo e
    // nome-classe (in lista bianca): nessun dato di minori.
    logEvento('auth', 'warn', {
      tipo: 'classe-fuori-sede', azione: 'assertClasseNomeInScope',
      utente: user.id, ruolo: user.role, sezione: classeNome,
    })
    return NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
  }

  if (opts?.soloSezioniAssegnate && !vedeTutteLeClassi(user)) {
    const mie = new Set(await sezioniDiUtente(supabase, user.id))
    if (!data.some((s) => mie.has(s.id as string))) {
      logEvento('auth', 'warn', {
        tipo: 'classe-non-assegnata', azione: 'assertClasseNomeInScope',
        utente: user.id, ruolo: user.role, sezione: classeNome,
      })
      return NextResponse.json({ error: 'Classe non assegnata al docente' }, { status: 403 })
    }
  }
  return null
}

/**
 * Verifica batched che TUTTI gli alunni indicati appartengano alla sezione data.
 * Per gli handler che ricevono array di alunno_id dentro una sezione GIÀ asserita
 * con assertSezioneInScope (appello, note, destinatari registro, giudizi scrutinio):
 * impedisce scritture/notifiche verso alunni di altre sezioni/plessi. 403 se anche
 * un solo id è estraneo alla sezione.
 */
export async function assertAlunniInSezione(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
  sectionId: string,
): Promise<NextResponse | null> {
  const ids = [...new Set(alunnoIds.filter(Boolean) as string[])]
  if (ids.length === 0) return null
  const { data, error } = await supabase
    .from('alunni')
    .select('id')
    .in('id', ids)
    .eq('section_id', sectionId)
  // Senza questo controllo una lettura fallita («data: null») faceva risultare
  // estranei TUTTI gli id: un 403 che accusa anche gli alunni giusti, e che il
  // chiamante non può distinguere da un vero tentativo cross-sezione.
  if (error) return scopeNonRisolto('scope-alunni-non-risolti', error, { sezione: sectionId })
  const inSezione = new Set((data ?? []).map((r) => r.id as string))
  const estranei = ids.filter((id) => !inSezione.has(id))
  if (estranei.length > 0) {
    // Gli uuid NON tornano nel corpo. Fino al 2026-07-31 la risposta li
    // elencava: a chi ha appena provato a toccare alunni non suoi si
    // confermava, id per id, quali esistono e non sono nella sezione — l'unica
    // informazione che quel 403 esiste per non dare. Per la diagnosi restano la
    // sezione, i due conteggi e — sul canale persistito — il payload già redatto
    // dal contesto di richiesta, dove gli id (uuid) ci sono per intero.
    logEvento('auth', 'warn', {
      tipo: 'alunni-fuori-sezione', azione: 'assertAlunniInSezione',
      sezione: sectionId, n: estranei.length, richiesti: ids.length,
    })
    return NextResponse.json(
      { error: 'Alunni non appartenenti alla sezione' },
      { status: 403 }
    )
  }
  return null
}

/**
 * Verifica che un altro membro dello STAFF (`utenti.id`) sia nel plesso
 * dell'utente. Per le operazioni che agiscono su un collega — reset delle
 * credenziali, assegnazione a una sezione, cambio di ruolo — dove il solo gate
 * di ruolo lasciava agire sul personale di un'altra sede. 403/404 se fuori scope.
 */
export async function assertUtenteInScope(
  supabase: SupabaseClient,
  user: AppUser,
  utenteId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!utenteId) {
    return NextResponse.json({ error: 'utenteId obbligatorio' }, { status: 400 })
  }
  const { data: bersaglio, error } = await supabase
    .from('utenti')
    .select('id, scuola_id')
    .eq('id', utenteId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-utente-non-risolto', error, { utente: user.id })
  if (!bersaglio) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (!bersaglio.scuola_id || !plessi.includes(bersaglio.scuola_id as string)) {
    logEvento('auth', 'warn', {
      tipo: 'utente-fuori-sede', azione: 'assertUtenteInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Utente fuori dal tuo plesso' }, { status: 403 })
  }
  return null
}

/**
 * Verifica che un PAGAMENTO sia nel plesso dell'utente.
 *
 * `pagamenti` ha già `scuola_id`, e per la contabilità è quella che conta: una
 * retta appartiene a un plesso, indipendentemente da dove sia il bambino
 * adesso. Serve a tutte le route che agiscono su un pagamento per uuid —
 * incassi, storni, sconti, quote, fatture, ricevute — dove il solo gate di
 * ruolo lasciava incassare e stornare sulle rette di un'altra sede.
 *
 * Sede assente sulla riga ⇒ si nega: un movimento contabile senza plesso non è
 * attribuibile a nessuno.
 */
export async function assertPagamentoInScope(
  supabase: SupabaseClient,
  user: AppUser,
  pagamentoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!pagamentoId) {
    return NextResponse.json({ error: 'pagamento_id obbligatorio' }, { status: 400 })
  }
  const { data: pagamento, error } = await supabase
    .from('pagamenti')
    .select('id, scuola_id')
    .eq('id', pagamentoId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-pagamento-non-risolto', error, { utente: user.id })
  if (!pagamento) {
    return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  const sede = (pagamento.scuola_id as string | null) ?? null
  if (!sede || !plessi.includes(sede)) {
    logEvento('auth', 'warn', {
      tipo: 'pagamento-fuori-sede', azione: 'assertPagamentoInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Pagamento fuori dal tuo plesso' }, { status: 403 })
  }
  return null
}

/**
 * Verifica che un GENITORE sia nello scope dell'utente.
 *
 * `parents` non ha `scuola_id`, e **non deve averlo**: un genitore può avere
 * legittimamente figli in due sedi diverse, quindi non esiste «la sua sede». Lo
 * scope si deriva dai FIGLI: il genitore è raggiungibile se almeno uno dei suoi
 * figli sta in un plesso dell'utente. Da usare su tutte le route che leggono o
 * scrivono l'anagrafica dei genitori per id (CF, documento d'identità,
 * indirizzo, recapiti) — dove il solo `requireStaff` lasciava passare qualunque
 * genitore delle tre sedi.
 *
 * Fail-closed: nessun plesso, errore di lettura, o nessun figlio in scope → si
 * nega. Un genitore senza figli collegati non è raggiungibile da nessuno: è la
 * risposta giusta, perché non c'è modo di stabilire a quale plesso appartenga.
 */
export async function assertParentInScope(
  supabase: SupabaseClient,
  user: AppUser,
  parentId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!parentId) {
    return NextResponse.json({ error: 'parentId obbligatorio' }, { status: 400 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) {
    return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 403 })
  }
  const { data, error } = await supabase
    .from('student_parents')
    .select('student_id, alunni!inner(scuola_id)')
    .eq('parent_id', parentId)
    .in('alunni.scuola_id', plessi)
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    return scopeNonRisolto('scope-genitore-non-risolto', error, { utente: user.id })
  }
  if (data && data.length > 0) return null

  // ── Da qui in giù si NEGA comunque: si stabilisce solo COME, e cosa scrivere.
  //
  // Fino al 2026-07-31 tutto questo era un `return 403 + warn genitore-fuori-sede`.
  // Provato con un uuid inesistente, rispondeva «Genitore fuori dal tuo plesso»
  // e incrementava un contatore nato come SEGNALE DI SICUREZZA: bastavano i 404
  // banali di un id sbagliato per riempirlo, e il giorno in cui qualcuno prova
  // davvero a leggere il genitore di un'altra sede quel segnale non si distingue
  // dal rumore. «Non è tuo» e «non esiste» sono due cose diverse e vanno dette
  // diverse. Il costo sta tutto sul ramo di diniego: il percorso felice resta
  // una query sola.
  const { data: altrove, error: errAltrove } = await supabase
    .from('student_parents')
    .select('student_id, alunni!inner(scuola_id)')
    .eq('parent_id', parentId)
    .limit(1)
  if (errAltrove) return scopeNonRisolto('scope-genitore-non-risolto', errAltrove, { utente: user.id })
  if (altrove && altrove.length > 0) {
    // Ha figli, ma non nei tuoi plessi: QUESTO è il tentativo cross-sede.
    logEvento('auth', 'warn', {
      tipo: 'genitore-fuori-sede', azione: 'assertParentInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Genitore fuori dal tuo plesso' }, { status: 403 })
  }

  // Nessun figlio collegato: o l'anagrafica non esiste (404 banale), o esiste e
  // non è attribuibile a nessun plesso (403, ma non è un tentativo).
  const { data: anagrafica, error: errAnagrafica } = await supabase
    .from('parents')
    .select('id')
    .eq('id', parentId)
    .maybeSingle()
  if (errAnagrafica) {
    // Mai affermare «non trovato» su un dato che non si è riusciti a leggere.
    return scopeNonRisolto('scope-genitore-non-risolto', errAnagrafica, { utente: user.id })
  }
  if (!anagrafica) {
    return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 })
  }
  logEvento('auth', 'warn', {
    tipo: 'genitore-senza-figli', azione: 'assertParentInScope',
    utente: user.id, ruolo: user.role,
  })
  return NextResponse.json({ error: 'Genitore non collegato a nessun alunno' }, { status: 403 })
}

/**
 * Verifica che l'alunno (`alunnoId`) sia nello scope dell'utente, risolvendo la
 * sua sezione/plesso. Per gli endpoint che ricevono alunnoId e non sectionId
 * (valutazioni, prospetto, fascicolo, diario, ...). 403/404 se fuori scope.
 */
export async function assertAlunnoInScope(
  supabase: SupabaseClient,
  user: AppUser,
  alunnoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!alunnoId) {
    return NextResponse.json({ error: 'alunnoId obbligatorio' }, { status: 400 })
  }
  const { data: alunno, error } = await supabase
    .from('alunni')
    .select('id, section_id, scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-alunno-non-risolto', error, { utente: user.id })
  if (!alunno) {
    return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!alunno.scuola_id || !plessi.includes(alunno.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!alunno.section_id || !mie.includes(alunno.section_id as string)) {
      return NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 })
    }
  }
  return null
}
