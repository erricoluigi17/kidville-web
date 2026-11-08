import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from './require-staff'
import { sezioniDiUtente, sezioniVisibiliDiUtente } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from './rifiuto-sede'
import { erroreAnno } from '@/lib/anno/errori'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { anniDellaSede, esitoSchemaIndietro, guastoAnno, type RigaAnnoSede } from '@/lib/anno/lettura'
import { creaGettoni } from '@/lib/anno/gettone'
import { anniAttiviDeiPlessi, filtraPerAnnoDiSede, type AnniAttivi } from '@/lib/anno/anni-attivi'
import type { EsitoAnno, StatoAnno } from '@/lib/anno/tipi'

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
export function formaConfronto(id: string): string {
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
 *
 * `accessibili` (facoltativo): le sedi dell'utente che il chiamante ha GIÀ letto con
 * `scuoleDiUtente`. Passate, non si rilegge `utenti_scuole`: per un admin sarebbe una
 * seconda lettura dello stesso ponte, e se fallisse lei sola lo scope diventerebbe
 * `[]` — un elenco «vuoto» dopo un controllo di sede appena superato. Chi non le passa
 * ottiene il comportamento di sempre.
 */
export async function resolveScuoleAttive(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  accessibili?: string[],
): Promise<string[]> {
  const sedi = accessibili ?? (await scuoleDiUtente(supabase, user))
  const selezionate = sediDalCookie(request)
  if (selezionate.length === 0) return sedi
  const inter = sediInScope(selezionate, indiceSedi(sedi))
  if (inter.length === 0) {
    // `warn` → persistito: nessuna sede selezionata è accessibile. Solo uuid
    // utente, ruolo e conteggi: nessun dato di minori, nessuna sede in chiaro.
    logEvento('auth', 'warn', {
      tipo: 'sedi-attive-non-accessibili', azione: 'resolveScuoleAttive',
      utente: user.id, ruolo: user.role,
      selezionate: selezionate.length, accessibili: sedi.length,
    })
  }
  return inter
}

/**
 * LETTURE, secondo tempo: la sede chiesta dal CLIENT **interseca**, non sostituisce.
 *
 * `resolveScuoleAttive` dice su quali plessi l'utente può leggere. Una schermata
 * può poi chiedere di guardarne uno solo (un filtro «Sede» nella barra, un
 * `?scuolaId=` in un collegamento): quella richiesta può soltanto RESTRINGERE.
 * Un uuid scritto a mano nella query non allarga mai il perimetro.
 *
 * ⚠️ I DUE RITORNI VUOTI SIGNIFICANO COSE OPPOSTE, e vanno tenuti distinti:
 *  · `[]`   → «non hai nessun plesso» (nessuna sede attiva e nessuna richiesta).
 *            I chiamanti lo trattano come elenco vuoto, che è la risposta giusta.
 *  · `null` → «hai chiesto un plesso che non è tuo». Il chiamante **rifiuta**
 *            (`rifiutoSede('SEDE_NON_ACCESSIBILE')`), che è ciò che
 *            `documenti-firmati/route.ts` fa già a mano.
 * Confonderli vorrebbe dire o rispondere 403 a chi semplicemente non ha sedi, o
 * rispondere «elenco vuoto» a un tentativo cross-sede — cioè perdere il segnale.
 *
 * ⚠️ IL CONFRONTO IGNORA LE MAIUSCOLE, e non è un vezzo: in Postgres `uuid` è un
 * TIPO, quindi `'AAAA…'` e `'aaaa…'` sono lo stesso valore e la riga si trova; in
 * JavaScript sono due stringhe diverse. È lo stesso difetto che il 2026-07-31 ha
 * fatto rispondere **403 sulla PROPRIA sede** a una segreteria che la scriveva in
 * maiuscolo (vedi `formaConfronto`). Le copie scritte a mano nelle rotte usano
 * `===` e quel difetto ce l'hanno ancora: qui non nasce. Ciò che esce è sempre la
 * forma CANONICA del database, mai la stringa arrivata dal client.
 *
 * Uso tipico (rimpiazza le tre righe scritte a mano in `documenti-firmati`):
 * ```ts
 * const plessi = await resolveScuoleAttive(request, supabase, user)
 * if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })
 * const scope = restringiSedi(plessi, q.data.scuolaId)
 * if (!scope) return rifiutoSede('SEDE_NON_ACCESSIBILE')
 * query = query.in('scuola_id', scope)
 * ```
 */
export function restringiSedi(attive: string[], scuolaId?: string | null): string[] | null {
  if (!scuolaId) return attive
  const richiesta = formaConfronto(scuolaId)
  const dentro = attive.filter((id) => formaConfronto(id) === richiesta)
  return dentro.length > 0 ? dentro : null
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

// =============================================================================
// L'ANNO SCOLASTICO nelle scritture (PR 3, Compito 3.2): il gemello di `resolveScuolaScrittura`.
//
// ⚠️ DUE UUID CHE NON SI SCAMBIANO.
//  · `anni_scolastici.id` — l'anno, uguale per tutte le sedi. È ciò che il client dichiara
//    (`anno_id`), ciò che sta nel cookie `anno_attivo`, ciò che `anno_di` restituisce, ciò che
//    `conAnno()` scrive nel payload (`EsitoAnno.annoId`).
//  · `anni_sede.id` — l'anno DI UNA SEDE. È ciò a cui si legano i gettoni di correzione
//    (`correzioni_anno_chiuso.anno_sede_id`) e ciò che restituisce `anno_attivo` (`EsitoAnno.annoSedeId`).
// Dal primo si arriva al secondo con la sede (`anni_sede.scuola_id + anno_id`), mai il contrario a occhio.
//
// Qui non si legge MAI la data di oggi per scegliere un anno: l'anno si dichiara, si sceglie (cookie)
// o è l'unico `corrente` della sede. In agosto, senza `corrente`, la risposta è 400 ANNO_DA_SPECIFICARE.
// =============================================================================

/** Il cookie con cui Direzione e segreteria scelgono l'anno: contiene `anni_scolastici.id`. */
export const COOKIE_ANNO = 'anno_attivo'
const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Il cookie `anno_attivo`: un valore che non è un uuid si ignora, come se mancasse. L'uuid esce in
 * forma canonica (minuscolo), la stessa del database.
 */
export function annoDalCookie(request: NextRequest): string | null {
  const raw = request.cookies?.get?.(COOKIE_ANNO)?.value?.trim()
  return raw && FORMA_UUID.test(raw) ? formaConfronto(raw) : null
}

function rifiutoAnno(codice: string, operazione: string): NextResponse {
  // `erroreAnno` conosce tutti i codici di questo file: `null` non può uscire.
  return erroreAnno({ message: codice }, operazione) as NextResponse
}

export type OpzioniAnnoScrittura = {
  /** `anni_scolastici.id` dichiarato dal client (corpo o query), già validato da zod. */
  dichiarato?: string
  /** Solo per Direzione e segreteria su un anno `chiuso`. Il motivo non esce mai in un log. */
  correzione?: { motivo: string }
  /** Quanti gettoni creare (default 1, massimo 10): un gettone vale una sola transazione. */
  usi?: number
}

/**
 * Le regole sullo STATO dell'anno (specifica §4.5), comuni a `resolveAnnoScrittura` e `annoDellaData`.
 *
 * | stato                                  | staff                          | tutti gli altri     |
 * |----------------------------------------|--------------------------------|---------------------|
 * | `in_preparazione`/`iscrizioni_aperte`  | passa                          | 403 ANNO_NON_VISIBILE |
 * | `corrente`                             | passa                          | passa               |
 * | `in_chiusura`                          | gettone `agosto`               | 409 ANNO_CHIUSO     |
 * | `chiuso`                               | 409, o gettone `correzione`    | 409 ANNO_CHIUSO     |
 *
 * «Staff» è `vedeTutteLeClassi` (admin, coordinator e segreteria): un docente con `correzione` non ottiene mai
 * un gettone. `utente_id` del gettone è `AppUser.id` (= `utenti.id` = `auth.users.id` per lo staff).
 */
/**
 * Un anno `in_chiusura`/`chiuso` senza gettone (Ruling P48). Finché la guardia è spenta
 * (`anno_regole.guardia_attiva = false`) nessuna scrittura che oggi passa va rifiutata (D1): l'esito
 * NON dichiara l'anno (`osservato`), la regola transitoria del database lo assegna come prima, e un
 * `warn` `anno-chiuso-osservato` la conta. Guardia accesa → 409 `ANNO_CHIUSO`, come sempre.
 * Lettura fallita o schema assente → si osserva: con la guardia accesa decide comunque il trigger.
 * La lettura avviene solo in questo ramo. La 3-B toglie il ramo insieme alla guardia spenta.
 */
async function rifiutoOsservandoLaGuardia(
  supabase: SupabaseClient,
  riga: RigaAnnoSede,
  azione: string,
): Promise<EsitoAnno | NextResponse> {
  const { data, error } = await supabase.from('anno_regole').select('guardia_attiva').limit(1)
  if (!error) {
    const attiva = (Array.isArray(data) ? data[0] : null) as { guardia_attiva?: boolean } | null
    if (attiva?.guardia_attiva === true) return rifiutoAnno('ANNO_CHIUSO', azione)
  } else if (!schemaAnnoIndietro(error)) {
    logEvento('anno-scolastico', 'warn', { tipo: 'guardia-non-letta', azione, error_code: error.code ?? 'sconosciuto' })
  }
  logEvento('anno-scolastico', 'warn', {
    tipo: 'anno-chiuso-osservato', azione, error_code: 'ANNO_CHIUSO', anno_sede_id: riga.id,
  })
  return { annoSedeId: riga.id, annoId: null, stato: riga.stato, osservato: true }
}

async function esitoPerAnno(
  supabase: SupabaseClient,
  user: AppUser,
  riga: RigaAnnoSede,
  opzioni: OpzioniAnnoScrittura,
  azione: string,
): Promise<EsitoAnno | NextResponse> {
  const base: EsitoAnno = { annoSedeId: riga.id, annoId: riga.anno_id, stato: riga.stato }
  const staff = vedeTutteLeClassi(user)
  let codice: 'agosto' | 'correzione'
  let motivo: string | undefined

  switch (riga.stato) {
    case 'corrente':
      return base
    case 'in_preparazione':
    case 'iscrizioni_aperte':
      if (staff) return base
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-non-visibile', azione, error_code: 'ANNO_NON_VISIBILE', utente: user.id, ruolo: user.role,
      })
      return rifiutoAnno('ANNO_NON_VISIBILE', azione)
    case 'in_chiusura':
      if (!staff) return rifiutoOsservandoLaGuardia(supabase, riga, azione)
      codice = 'agosto'
      break
    case 'chiuso': {
      if (!staff || !opzioni.correzione) return rifiutoOsservandoLaGuardia(supabase, riga, azione)
      motivo = typeof opzioni.correzione.motivo === 'string' ? opzioni.correzione.motivo.trim() : ''
      if (!motivo) return rifiutoAnno('MOTIVO_OBBLIGATORIO', azione)
      codice = 'correzione'
      break
    }
    default:
      // Uno stato che questo codice non conosce: si chiude, non si apre.
      return rifiutoAnno('ANNO_CHIUSO', azione)
  }

  const ids = await creaGettoni(supabase, {
    annoSedeId: riga.id, utenteId: user.id, ruolo: user.role, codice, motivo, usi: opzioni.usi,
  })
  if (!ids) {
    // Già loggato da `creaGettoni` (solo il codice di Postgres: il motivo non esce mai).
    return NextResponse.json({ error: 'Verifica di scope non riuscita', codice: 'SCRITTURA_FALLITA' }, { status: 500 })
  }
  return { ...base, gettone: ids[0], gettoni: ids }
}

/**
 * L'anno a cui appartiene una SCRITTURA. Ordine: (1) `opzioni.dichiarato`; (2) il cookie
 * `anno_attivo`; (3) l'UNICO anno `corrente` della sede (l'indice `anni_sede_un_corrente_per_sede`
 * ne garantisce al massimo uno). Non «l'unico non chiuso»: dalla PR 2 ogni sede ha sempre un
 * `in_preparazione`, e «non chiuso» darebbe due anni dal giorno del merge (Ruling D2).
 *
 * Nessuna delle tre → 400 `ANNO_DA_SPECIFICARE` + `warn` `anno-scrittura-ambigua`. In agosto (il
 * vecchio è `in_chiusura`, il nuovo `in_preparazione`, nessun `corrente`) è voluto: la PR 4.2 mette
 * di default il cookie `anno_attivo` PRIMA del 01/08/2027.
 *
 * Un anno dichiarato (o nel cookie) che la sede non ha → 400 `ANNO_NON_DELLA_SEDE` + `warn`.
 * Gli uuid si confrontano senza distinzione di maiuscole (`formaConfronto`) e escono in forma
 * canonica, quella del database.
 *
 * Sul database senza lo schema dell'anno (CI) risponde `{ annoSedeId: null, … schemaIndietro: true }`:
 * il chiamante scrive il payload con `conAnno(esito)`.
 */
export async function resolveAnnoScrittura(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  opzioni: OpzioniAnnoScrittura = {},
): Promise<EsitoAnno | NextResponse> {
  const azione = 'resolveAnnoScrittura'
  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) return esitoSchemaIndietro(azione)
  if ('guasto' in anni) return guastoAnno(azione, anni.guasto)
  const { righe } = anni
  const perAnno = new Map(righe.map((r) => [formaConfronto(String(r.anno_id)), r]))

  // Come `resolveAnnoLettura`: il cookie lo seguono solo Direzione e segreteria. Per tutti gli altri si ignora (con
  // lo stesso `warn` se c'era) e la scrittura va sull'anno `corrente`, a meno che il client non dichiari l'anno.
  const cookie = annoDalCookie(request)
  if (!vedeTutteLeClassi(user) && cookie) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-cookie-ignorato-ruolo', azione, utente: user.id, ruolo: user.role,
    })
  }
  const richiesto = opzioni.dichiarato?.trim() || (vedeTutteLeClassi(user) ? cookie : null)
  let riga: RigaAnnoSede | undefined
  if (richiesto) {
    riga = perAnno.get(formaConfronto(richiesto))
    if (!riga) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-non-della-sede', azione, error_code: 'ANNO_NON_DELLA_SEDE',
        utente: user.id, ruolo: user.role,
      })
      return rifiutoAnno('ANNO_NON_DELLA_SEDE', azione)
    }
  } else {
    const correnti = righe.filter((r) => r.stato === 'corrente')
    if (correnti.length === 1) riga = correnti[0]
    else {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-scrittura-ambigua', azione, error_code: 'ANNO_DA_SPECIFICARE',
        utente: user.id, ruolo: user.role,
        anni_candidati: righe.filter((r) => r.stato !== 'chiuso').length,
      })
      return rifiutoAnno('ANNO_DA_SPECIFICARE', azione)
    }
  }
  return esitoPerAnno(supabase, user, riga, opzioni, azione)
}

/** L'anno su cui si LEGGE (`resolveAnnoLettura`). `annoId` è `anni_scolastici.id`, `annoSedeId` è `anni_sede.id`. */
export type AnnoLettura = { annoSedeId: string; annoId: string; stato: StatoAnno; eAttivo: boolean }

/**
 * L'anno su cui LEGGERE. Ordine: `opzioni.dichiarato` (`anni_scolastici.id`, già validato da zod dal
 * chiamante) → cookie `anno_attivo` → `anno_attivo(sede)`. Non risponde mai `ANNO_DA_SPECIFICARE`:
 * leggere si può sempre, e l'anno predefinito è l'anno attivo.
 *
 * Direzione (admin e coordinator) e segreteria (`vedeTutteLeClassi`) scelgono l'anno. Docenti e genitori NO: per loro il
 * cookie è ignorato (con un `warn` solo se c'era) e vale l'anno attivo; l'anno dichiarato lo
 * possono chiedere, ma `in_preparazione`/`iscrizioni_aperte` è `403 ANNO_NON_VISIBILE`.
 * Un anno (cookie o dichiarato) che la sede non ha è `403 ANNO_NON_ACCESSIBILE`, come un cookie di
 * sede manomesso: nel log non entra mai il valore.
 *
 * `null` = calendario non disponibile (database senza lo schema dell'anno, o sede senza anno
 * attivo e nessuno scelto): chi chiama legge senza filtro d'anno, come prima della PR 4.2.
 */
export async function resolveAnnoLettura(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  opzioni: { dichiarato?: string } = {},
): Promise<AnnoLettura | null | NextResponse> {
  const azione = 'resolveAnnoLettura'
  // Il motivo va sotto `esito`: `motivo` è una radice di testo libero per `redact` e uscirebbe `[redatto:str/N]`.
  const nonDisponibile = (motivo: string): null => {
    logEvento('anno-scolastico', 'info', { tipo: 'calendario-non-disponibile', azione, esito: motivo })
    return null
  }

  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) return nonDisponibile('schema-indietro')
  if ('guasto' in anni) return guastoAnno(azione, anni.guasto)

  const attivo = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
  if (attivo.error) {
    if (schemaAnnoIndietro(attivo.error)) return nonDisponibile('schema-indietro')
    return guastoAnno(azione, attivo.error)
  }
  const attivoId = typeof attivo.data === 'string' ? attivo.data : null

  const staff = vedeTutteLeClassi(user)
  const dichiarato = opzioni.dichiarato?.trim() || null
  const cookie = annoDalCookie(request)
  if (!staff && cookie) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-cookie-ignorato-ruolo', azione, utente: user.id, ruolo: user.role,
    })
  }
  const richiesto = dichiarato ?? (staff ? cookie : null)

  const perAnno = new Map(anni.righe.map((r) => [formaConfronto(String(r.anno_id)), r]))
  let riga: RigaAnnoSede | undefined
  if (richiesto) {
    riga = perAnno.get(formaConfronto(richiesto))
    if (!riga) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-lettura-cookie-fuori-scope', azione, error_code: 'ANNO_NON_ACCESSIBILE',
        utente: user.id, ruolo: user.role, // `fonte` non è fra le chiavi in chiaro di `redact`: il valore sta sotto `esito`.
        esito: dichiarato ? 'dichiarato' : 'cookie',
      })
      return rifiutoAnno('ANNO_NON_ACCESSIBILE', azione)
    }
  } else {
    riga = anni.righe.find((r) => r.id === attivoId)
    if (!riga) return nonDisponibile('nessun-anno-attivo')
  }

  if (!staff && (riga.stato === 'in_preparazione' || riga.stato === 'iscrizioni_aperte')) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-non-visibile', azione, error_code: 'ANNO_NON_VISIBILE', utente: user.id, ruolo: user.role,
    })
    return rifiutoAnno('ANNO_NON_VISIBILE', azione)
  }
  return { annoSedeId: riga.id, annoId: riga.anno_id, stato: riga.stato, eAttivo: riga.id === attivoId }
}

/**
 * L'anno su cui LEGGERE un ELENCO che può attraversare più sedi (Compito 4.3.7). Il passaggio d'anno è PER SEDE, quindi
 * il risultato è un insieme di coppie sede→anno (`AnniAttivi`), da applicare con `filtraPerAnnoDiSede`:
 *  · senza cookie, o per chi non è Direzione/segreteria (il cookie si ignora, con lo stesso `warn` di
 *    `resolveAnnoLettura`): l'anno ATTIVO di ciascuna sede (`anniAttiviDeiPlessi`);
 *  · Direzione e segreteria con il cookie: quell'anno per le sedi che lo hanno, e una sede che non lo ha resta VUOTA.
 *    `403 ANNO_NON_ACCESSIBILE` solo se NESSUNA sede dell'elenco lo ha, così l'esito non dipende dall'ordine delle sedi;
 *  · una sede senza righe, senza anno attivo o con la lettura fallita non sparisce: per lei niente filtro (fail-open,
 *    come il DB della CI), con un `warn` col solo codice quando è un guasto;
 *  · `null` = nessun filtro per nessuna sede (DB non migrato, nessun plesso).
 */
export async function resolveAnnoLetturaElenco(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  plessi: readonly string[],
): Promise<AnniAttivi | null | NextResponse> {
  const azione = 'resolveAnnoLetturaElenco'
  const sedi = [...new Set(plessi)]
  if (sedi.length === 0) return null
  const staff = vedeTutteLeClassi(user)
  const cookie = annoDalCookie(request)
  if (!staff && cookie) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-cookie-ignorato-ruolo', azione, utente: user.id, ruolo: user.role,
    })
  }
  if (!staff || !cookie) return anniAttiviDeiPlessi(supabase, sedi)

  const coppie: { sede: string; annoId: string }[] = []
  const liberi: string[] = []
  for (const sede of sedi) {
    const anni = await anniDellaSede(supabase, sede)
    if ('indietro' in anni) {
      logEvento('anno-scolastico', 'info', { tipo: 'calendario-non-disponibile', azione, esito: 'schema-indietro' })
      return null
    }
    if ('guasto' in anni) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anni-sede-non-letti', azione }, anni.guasto)
      liberi.push(sede)
      continue
    }
    const riga = anni.righe.find((r) => formaConfronto(String(r.anno_id)) === cookie)
    if (riga) coppie.push({ sede, annoId: String(riga.anno_id) })
  }
  if (coppie.length === 0 && liberi.length === 0) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-lettura-cookie-fuori-scope', azione, error_code: 'ANNO_NON_ACCESSIBILE',
      utente: user.id, ruolo: user.role, esito: 'cookie',
    })
    return rifiutoAnno('ANNO_NON_ACCESSIBILE', azione)
  }
  return coppie.length > 0 ? { coppie, liberi } : null
}

/**
 * L'anno di una scrittura con una DATA (le tabelle in modo `data`: l'anno lo calcola il database).
 * `giorno` è `AAAA-MM-GG`. Stesse regole sullo stato di `resolveAnnoScrittura`; non legge mai il
 * cookie. `anno_di` restituisce `anni_scolastici.id` e NULL se nessun anno copre il giorno: allora
 * 500 `GIORNO_SENZA_ANNO` (con `logErrore`, da `erroreAnno`).
 */
export async function annoDellaData(
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  giorno: string,
  opzioni: Pick<OpzioniAnnoScrittura, 'correzione' | 'usi'> = {},
): Promise<EsitoAnno | NextResponse> {
  const azione = 'annoDellaData'
  const { data, error } = await supabase.rpc('anno_di', { p_scuola: scuolaId, p_giorno: giorno })
  if (error) {
    if (schemaAnnoIndietro(error)) return esitoSchemaIndietro(azione)
    return erroreAnno(error, azione) ?? guastoAnno(azione, error)
  }
  if (typeof data !== 'string' || !data) return rifiutoAnno('GIORNO_SENZA_ANNO', azione)
  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) return esitoSchemaIndietro(azione)
  if ('guasto' in anni) return guastoAnno(azione, anni.guasto)
  const riga = anni.righe.find((r) => formaConfronto(String(r.anno_id)) === formaConfronto(data))
  if (!riga) return rifiutoAnno('GIORNO_SENZA_ANNO', azione)
  return esitoPerAnno(supabase, user, riga, opzioni, azione)
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
  return await verificaSezione(supabase, user, sectionId, false)
}

/**
 * Come `assertSezioneInScope`, per le SCRITTURE: in più, un docente che vede la sezione in sola lettura (anno
 * `in_chiusura` o `chiuso`) riceve **403** con `codice: 'SEZIONE_SOLA_LETTURA'`. Direzione e segreteria
 * (`vedeTutteLeClassi`) non hanno mai sola lettura qui: l'anno chiuso per loro lo difende il database (PR 3-B).
 * Le `GET` restano su `assertSezioneInScope`.
 */
export async function assertSezioneScrivibile(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string | null | undefined,
): Promise<NextResponse | null> {
  return await verificaSezione(supabase, user, sectionId, true)
}

async function verificaSezione(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string | null | undefined,
  inScrittura: boolean,
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
    const mie = await sezioniVisibiliDiUtente(supabase, user.id)
    const mia = mie.find(m => m.sectionId === sectionId)
    if (!mia) {
      return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
    }
    if (inScrittura && mia.solaLettura) {
      logEvento('auth', 'warn', {
        tipo: 'sezione-sola-lettura', azione: 'assertSezioneScrivibile', utente: user.id, sezione: sectionId,
      })
      return NextResponse.json(
        { error: 'Questa classe è di un anno passato: è in sola lettura', codice: 'SEZIONE_SOLA_LETTURA' },
        { status: 403 },
      )
    }
  }
  return null
}

/**
 * FIRMA DEL REGISTRO DI PRIMARIA — un gate SUO, e il motivo per cui non è
 * `assertSezioneInScope` con un'opzione in più.
 *
 * ─── LA DECISIONE (titolare, 2026-09-09) ────────────────────────────────────
 * Un docente può firmare il registro in QUALUNQUE sezione `school_type =
 * 'primaria'` della PROPRIA sede, anche in una che non gli è assegnata: è la
 * supplenza, e in una scuola vera succede ogni settimana. Misurato sul database
 * di produzione il 2026-09-09: 15 educator con grado primaria × 11 sezioni di
 * primaria dànno 75 combinazioni nella stessa sede, di cui **38 già assegnate e
 * 37 no**; 13 educator su 15 guadagnano almeno una classe in cui prima
 * ricevevano 403.
 *
 * ─── PERCHÉ UNA FUNZIONE NUOVA E NON UN PARAMETRO SU `assertSezioneInScope` ──
 * Perché quella la condividono valutazioni, note disciplinari, pagelle,
 * scrutinio e fascicolo — cioè l'anagrafica e i dati sanitari di 133 bambini.
 * Un'opzione `permettiSupplenza` lì dentro sarebbe a un `true` di distanza
 * dall'aprire tutto il resto, e il giorno che qualcuno la passasse per sbaglio
 * non se ne accorgerebbe nessuno: nessun test rosso, solo dati visibili a chi
 * non doveva. Il permesso più largo si scrive dove serve, non dove si condivide.
 *
 * ─── I CONFINI CHE RESTANO, E QUELLO CHE CADE ───────────────────────────────
 *  · la SEDE è invalicabile e fail-closed (`scuoleDiUtente` risponde `[]` su una
 *    lettura fallita, e da lì si nega): la classe deve stare in un plesso
 *    dell'utente. Ha un test negativo suo.
 *  · il GRADO della classe deve essere `primaria`: questa è la porta del
 *    registro di primaria, non di quello 0-6 (`register/lessons`).
 *  · cade SOLO il requisito dell'assegnazione in `utenti_sezioni` per
 *    l'`educator`. Non sparisce però: diventa un'ETICHETTA (`supplenza`) che il
 *    chiamante scrive nell'audit, perché «chi ha firmato in una classe non sua»
 *    è esattamente la domanda che ci si farà a posteriori.
 *
 * ⚠️ `sezioniDiUtente` risponde `[]` anche quando la lettura FALLISCE (logga e
 * degrada). Qui quel guasto non nega niente — non è più un permesso — e sposta
 * l'etichetta verso `supplenza: true`: si sovra-dichiara invece di tacere, che
 * per un audit è il verso giusto in cui sbagliare.
 */
export type EsitoFirmaPrimaria =
  | { response: NextResponse; supplenza?: undefined }
  | { response?: undefined; supplenza: boolean }

/**
 * «Questa COLONNA non esiste in questo database» — il DB E2E della CI non è
 * migrato. Fratello di `TABELLA_ASSENTE`, e tenuto separato apposta: qui una
 * colonna assente degrada il solo controllo del GRADO, mai quello della SEDE.
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * La sezione è firmabile da questo utente? Ritorna una risposta 4xx/5xx pronta,
 * oppure `supplenza: true` quando la classe NON è fra quelle assegnate.
 */
export async function assertSezionePrimariaFirmabile(
  supabase: SupabaseClient,
  user: AppUser,
  // `string` e non `string | null | undefined` come le `assert*` storiche: il
  // solo chiamante è `primaria/registro:POST`, dove `sectionId` è già passato da
  // `zUuid`. Un ramo «sectionId mancante» qui sarebbe una risposta d'errore in
  // più che nessuna richiesta può raggiungere, e il compilatore fa il lavoro
  // meglio di un `if`.
  sectionId: string,
): Promise<EsitoFirmaPrimaria> {
  // `sections.school_type` esiste su produzione e sul DB E2E (le journey 82 e 84
  // ci asseriscono sopra). Se un giorno non ci fosse, il GRADO degrada APERTO —
  // con una riga che lo dice — e la SEDE resta invariata: è il solo criterio che
  // non si degrada mai.
  let gradoNoto = true
  let res = await supabase
    .from('sections')
    .select('id, scuola_id, school_type')
    .eq('id', sectionId)
    .maybeSingle()
  if (res.error && COLONNA_ASSENTE.has((res.error as { code?: string }).code ?? '')) {
    logEvento('auth', 'warn', {
      tipo: 'firma-primaria-grado-non-leggibile', azione: 'assertSezionePrimariaFirmabile',
      utente: user.id, ruolo: user.role, sezione: sectionId,
    }, res.error)
    gradoNoto = false
    res = await supabase.from('sections').select('id, scuola_id').eq('id', sectionId).maybeSingle()
  }
  // PostgREST non lancia: senza questo controllo un guasto di lettura diventa un
  // 404 «Sezione non trovata», cioè un'affermazione su un dato che non si è letto.
  if (res.error) {
    return { response: scopeNonRisolto('scope-firma-primaria-non-risolta', res.error, { utente: user.id, sezione: sectionId }) }
  }
  const section = res.data as { id: string; scuola_id: string | null; school_type?: string | null } | null
  if (!section) {
    // Le due risposte NUOVE di questa funzione nascono col loro `codice`: una
    // risposta che nasce senza è debito che ricresce dentro il lock che esiste per
    // impedirlo (`__tests__/architecture/errori-con-codice.test.ts`). Le frasi
    // italiane restano come ripiego per i client vecchi; quelle che l'utente legge
    // stanno in `messages/{it,en}/shared.json`.
    return { response: NextResponse.json({ error: 'Sezione non trovata', codice: 'SEZIONE_NON_TROVATA' }, { status: 404 }) }
  }

  // 1) LA SEDE. Fail-closed: `scuoleDiUtente` torna `[]` su lettura fallita.
  const plessi = await scuoleDiUtente(supabase, user)
  if (!section.scuola_id || !plessi.includes(section.scuola_id)) {
    logEvento('auth', 'warn', {
      tipo: 'firma-primaria-fuori-sede', azione: 'assertSezionePrimariaFirmabile',
      utente: user.id, ruolo: user.role, sezione: sectionId,
    })
    // `rifiutoSede` e non una frase scritta a mano: il diniego di sede ha UN
    // codice (`SEDE_NON_ACCESSIBILE`) e il client lo traduce. Le funzioni sopra
    // hanno ancora la prosa italiana cablata — è il debito congelato da
    // `__tests__/architecture/errori-con-codice.test.ts` — ma una risposta NUOVA
    // non ha motivo di nascere già in italiano dentro un'interfaccia inglese.
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }

  // 2) IL GRADO DELLA CLASSE. Il registro 0-6 ha una porta sua.
  if (gradoNoto && section.school_type !== 'primaria') {
    logEvento('auth', 'warn', {
      tipo: 'firma-primaria-classe-non-primaria', azione: 'assertSezionePrimariaFirmabile',
      utente: user.id, ruolo: user.role, sezione: sectionId, grado: section.school_type ?? null,
    })
    return { response: NextResponse.json({ error: 'Questa classe non è di scuola primaria', codice: 'CLASSE_NON_DI_PRIMARIA' }, { status: 403 }) }
  }

  // 3) L'ASSEGNAZIONE: non è più un permesso, è un'etichetta.
  // Chi vede tutte le classi del plesso (admin/coordinator/segreteria) non fa
  // supplenza per definizione: agisce sull'intera scuola per progetto.
  if (vedeTutteLeClassi(user)) return { supplenza: false }
  // 3b) L'ANNO. La supplenza vale su qualunque classe di primaria della sede, ma solo nell'anno attivo: un
  // docente non firma il registro di una classe di un anno passato o non ancora iniziato.
  const rifiutoAnno = await rifiutoAnnoDellaFirma(supabase, user, section.id, section.scuola_id)
  if (rifiutoAnno) return { response: rifiutoAnno }
  const mie = await sezioniDiUtente(supabase, user.id)
  // Si confronta `section.id` (il valore CANONICO che arriva dal database) e non
  // la stringa del client: in Postgres `uuid` è un tipo, quindi `.eq()` avrebbe
  // trovato la riga anche in MAIUSCOLO, mentre `Array.includes` no — e la firma
  // di una classe propria sarebbe finita in audit come supplenza.
  return { supplenza: !mie.includes(section.id) }
}

/**
 * L'anno della classe, per chi firma senza vedere tutte le classi: `corrente` e basta.
 *  · `in_chiusura` o `chiuso` → 403 `SEZIONE_SOLA_LETTURA`;
 *  · `in_preparazione` o `iscrizioni_aperte` → lo stesso rifiuto di una classe che il docente non può usare
 *    (`SEDE_NON_ACCESSIBILE`: non si rivela che esiste);
 *  · colonna o tabella dell'anno assente (DB non migrato) → nessun controllo;
 *  · qualunque altra lettura fallita → rifiuto, come fa il resto del gate.
 */
async function rifiutoAnnoDellaFirma(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string,
  scuolaId: string,
): Promise<NextResponse | null> {
  const nonUsabile = () => rifiutoSede('SEDE_NON_ACCESSIBILE')
  const anno = await supabase.from('sections').select('anno_id').eq('id', sectionId).maybeSingle()
  if (anno.error) {
    if (schemaAnnoIndietro(anno.error)) return null
    return scopeNonRisolto('scope-firma-primaria-non-risolta', anno.error, { utente: user.id, sezione: sectionId })
  }
  const annoId = (anno.data as { anno_id?: string | null } | null)?.anno_id
  if (!annoId) return null
  const stato = await supabase.from('anni_sede').select('stato').eq('scuola_id', scuolaId).eq('anno_id', annoId).maybeSingle()
  if (stato.error) {
    if (schemaAnnoIndietro(stato.error)) return null
    return scopeNonRisolto('scope-firma-primaria-non-risolta', stato.error, { utente: user.id, sezione: sectionId })
  }
  const valore = (stato.data as { stato?: string | null } | null)?.stato
  if (valore === 'corrente') return null
  if (valore === 'in_chiusura' || valore === 'chiuso') {
    logEvento('auth', 'warn', {
      tipo: 'sezione-sola-lettura', azione: 'assertSezionePrimariaFirmabile', utente: user.id, sezione: sectionId,
    })
    return NextResponse.json(
      { error: 'Questa classe è di un anno passato: è in sola lettura', codice: 'SEZIONE_SOLA_LETTURA' },
      { status: 403 },
    )
  }
  return nonUsabile()
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
  // Il nome si ripete ogni anno: si risolve sull'anno ATTIVO dei plessi (`null` = niente filtro, DB non migrato).
  const anniAttivi = await anniAttiviDeiPlessi(supabase, plessi)
  let ricerca = supabase
    .from('sections')
    .select('id')
    .eq('name', classeNome)
    .in('scuola_id', plessi)
  ricerca = filtraPerAnnoDiSede(ricerca, anniAttivi)
  const { data, error } = await ricerca
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
