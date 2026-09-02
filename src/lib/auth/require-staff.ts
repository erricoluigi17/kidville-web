import { NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { impostaUtente } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'
import { ACTIVE_ROLE_COOKIE, leggiCookie, risolviRuoloAttivo } from './active-role'
// Dei cinque predicati si importano per nome solo i DUE che il corpo di questo
// file usa davvero (`haUnRuolo` nei tre gate, `ruoliDi` in `conPonteGenitore`,
// `conRuoloAttivo` e `nega`). Gli altri tre — `haRuolo`, `agisceComeGenitore`,
// `eFamiglia` — restano raggiungibili dall'esterno grazie alla sola
// ri-esportazione qui sotto: importarli anche per nome li renderebbe variabili non
// usate, e `no-unused-vars` è un errore nel gate.
import { haUnRuolo, ruoliDi, type AppRole, type AppUser, type StaffRole } from './predicati-ruolo'

/* ────────────────────────────────────────────────────────────────────────────
 * I TIPI E I PREDICATI STANNO IN `predicati-ruolo.ts`, E DA QUI SI RI-ESPORTANO
 *
 * Non è una preferenza di stile: **296 file** di test sostituiscono QUESTO modulo
 * per intero (`vi.mock('@/lib/auth/require-staff', () => ({ … }))`) per iniettare
 * un'identità senza toccare la sessione Supabase, e finché i predicati puri
 * vivevano qui dentro li sostituivano insieme all'I/O. Misurato: importare
 * `eFamiglia` da questo modulo dentro `require-parent.ts` faceva diventare rossi
 * 46 test su 7 file. Il perché per esteso sta nella testata di `predicati-ruolo.ts`.
 *
 * LA RI-ESPORTAZIONE È IL CONTRATTO, non un residuo da ripulire: i ~37 file che
 * fanno `import { … type AppUser } from '@/lib/auth/require-staff'` non cambiano di
 * una riga, e chi mocka questo modulo continua a mockare esattamente ciò che
 * mockava prima. Chi invece importa i predicati da `@/lib/auth/predicati-ruolo` li
 * ottiene VERI anche sotto mock totale — ed è tutta la ragione dell'estrazione.
 * ──────────────────────────────────────────────────────────────────────────── */

export type { AppRole, AppUser, StaffRole } from './predicati-ruolo'
export { agisceComeGenitore, eFamiglia, haRuolo, haUnRuolo, ruoliDi } from './predicati-ruolo'

/* ────────────────────────────────────────────────────────────────────────────
 * RUOLI REALI (database) vs RUOLO ATTIVO (cookie)
 *
 * IL FATTO. Quattro persone in produzione hanno insieme una riga `utenti` con
 * ruolo `educator` E il ponte `parents.auth_user_id` sullo stesso `auth.uid()`:
 * sono insegnanti che sono anche genitori di un bambino della scuola. Sei dei loro
 * legami figlio↔genitore cadono fuori dalle sezioni che insegnano, e uno è in
 * un'altra sede: aprendo il diario del PROPRIO figlio prendono 403.
 *
 * LA REGOLA, e vale per tutto il file:
 *
 *   AUTORIZZAZIONE = unione dei ruoli REALI, letti dal database.
 *   PRESENTAZIONE  = ruolo ATTIVO, scelto col cookie `kv-active-role`.
 *
 * Il cookie non concede e non revoca niente: sceglie QUALE delle proprie viste
 * legittime si sta guardando. Non è un'escalation perché i profili possibili sono
 * al massimo due — uno da `utenti.ruolo` (colonna scalare) e `genitore` solo se
 * esiste il ponte — e li produce il database, non il client.
 *
 * IL BUCO CHE SI CHIUDE QUI. Finora il cookie veniva validato al SET
 * (`POST /api/auth/active-role`) e mai più: dura 180 giorni, quindi se la direzione
 * degrada un `educator` a `cuoca` il cookie continua a dire `educator` per sei
 * mesi. Da qui in avanti il ruolo attivo si ri-valida a OGNI richiesta contro i
 * ruoli letti IN QUELLA STESSA richiesta.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Risultato dei controlli auth: o `{ user }`, o `{ response }` (401/403 pronta).
 */
export type AuthResult =
  | { user: AppUser; response?: undefined }
  | { user?: undefined; response: NextResponse }

/**
 * Estrae l'id utente dalla richiesta secondo il modello di auth REALE del
 * progetto (app-level, NON Supabase Auth): l'identità arriva come header
 * `x-user-id` oppure query `?userId=`. Vedi nota di sicurezza sotto.
 */
export function getRequestUserId(request: Request): string | null {
  const header = request.headers.get('x-user-id')
  if (header) return header
  try {
    const url = new URL(request.url)
    return url.searchParams.get('userId')
  } catch {
    return null
  }
}

export type IdentitySource = 'session' | 'header'

/** Le colonne di `utenti` che compongono un `AppUser`: una sola lista, due letture. */
const COLONNE_UTENTE = 'id, nome, cognome, ruolo, role, scuola_id'

/** La riga `utenti` così com'è letta: `role` è GENERATA da `ruolo`, non si scrive mai. */
export interface RigaUtenti {
  id: string
  nome?: string | null
  cognome?: string | null
  ruolo?: string | null
  role?: string | null
  scuola_id?: string | null
}

/** Ciò che si sa della persona dopo aver risolto la sua identità. */
export interface Identita {
  userId: string | null
  source: IdentitySource | null
  /**
   * La riga `utenti` GIÀ LETTA per `auth.uid()`. `null` = letta e assente,
   * `undefined` = non letta affatto (percorso header legacy: non c'è nessun uid
   * di sessione da cui partire). Chi la riusa deve distinguere i due casi.
   */
  rigaUtenti?: RigaUtenti | null
  /** Esiste `parents.auth_user_id == auth.uid()`? `undefined` = non verificato. */
  ponteGenitore?: boolean
}

/**
 * Mappa un `auth.uid()` (Supabase Auth) all'id applicativo, e porta con sé ciò che
 * ha letto per farlo.
 * - Staff: `utenti.id == auth.uid()` (la PK di `utenti` è FK → `auth.users`).
 * - Genitori: `parents.auth_user_id == auth.uid()` (ponte aggiunto in P0/S4).
 *
 * ⚠️ `utenti` VINCE su `parents`, e non è un difetto da correggere: i genitori
 * reali hanno anch'essi la riga `utenti` (vedi `profili.ts`), mentre `parents.id`
 * è una riga d'ANAGRAFICA separata. Invertire la precedenza rimapperebbe l'id
 * applicativo di un docente-genitore su `parents.id`, e `getFigliDiGenitoreEsito`
 * — che cerca `legame_genitori_alunni.genitore_id = accountId` — smetterebbe di
 * trovarlo: si romperebbe esattamente ciò che questo lavoro vuole aggiustare.
 *
 * LE DUE QUERY SONO PARALLELE, non più «e solo se manca». Prima erano 2-3 letture
 * SEQUENZIALI (utenti → parents → di nuovo utenti in `loadAppUser`); ora sono due,
 * insieme, ed è la stessa forma che `/api/me` usa già. Il ponte genitore — che è
 * l'informazione che serve a sapere se questa persona ha due vesti — arriva gratis.
 */
async function risolviDaAuthUid(authUid: string): Promise<{
  appId: string | null
  rigaUtenti: RigaUtenti | null
  ponteGenitore: boolean
}> {
  const supabase = await createAdminClient()
  const [staffRes, parentRes] = await Promise.all([
    supabase.from('utenti').select(COLONNE_UTENTE).eq('id', authUid).maybeSingle(),
    supabase.from('parents').select('id').eq('auth_user_id', authUid).maybeSingle(),
  ])

  // PostgREST NON LANCIA: ritorna `{ error }`. Un try/catch qui attorno non
  // scatterebbe mai, e finora l'errore veniva scartato dal destructuring — quindi
  // «la colonna ponte non esiste» e «il permesso è negato» erano lo stesso silenzio.
  // L'errore va al logger INTERO: porta `code`/`details`/`hint`, ed è quella terna
  // che distingue un 42703 (colonna assente sul DB E2E non migrato) da un permesso.
  if (staffRes.error)
    logEvento('auth', 'warn', { operazione: 'resolveIdentity', esito: 'utenti-non-letti' }, staffRes.error)
  if (parentRes.error)
    logEvento('auth', 'warn', { operazione: 'resolveIdentity', esito: 'parents-non-letti' }, parentRes.error)

  const riga = (staffRes.data ?? null) as RigaUtenti | null
  const parentId = (parentRes.data as { id?: string } | null)?.id ?? null
  return {
    appId: riga?.id ?? parentId,
    rigaUtenti: riga,
    ponteGenitore: !!parentId,
  }
}

/**
 * Risolve l'identità della richiesta preferendo la **sessione reale** (Supabase
 * Auth) all'identità legacy via header/query. Un `x-user-id`/`?userId=` fornito
 * dal client che **differisce** dalla sessione viene IGNORATO (anti-spoofing).
 *
 * Il percorso legacy (header/query) è onorato solo quando NON esiste sessione e
 * `ALLOW_HEADER_IDENTITY !== 'false'`. Il flag viene messo a `'false'` a fine P0
 * (S13) per sigillare l'auth a sola-sessione. Default (flag assente) =
 * retrocompatibile (header ancora ammesso) finché i client non sono ripuliti.
 *
 * ADDITIVA: `userId` e `source` sono quelli di sempre — i ~17 call site non
 * cambiano — e in più, sul percorso sessione, restituisce la riga `utenti` GIÀ
 * LETTA e il ponte genitore, così i gate non rileggono ciò che è già in mano.
 */
export async function resolveIdentity(request: Request): Promise<Identita> {
  // 1) Sessione reale. Avvolto in try/catch: createClient()/cookies() lancia
  //    fuori da un contesto di richiesta (e può non essere mockato in alcuni unit test).
  let sessionUid: string | null = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    sessionUid = data?.user?.id ?? null
  } catch (err) {
    // Errore IGNORABILE, e per questo si logga a `info` invece di tacere (AGENTS
    // regola 6: un catch che non logga è un bug; se un errore è davvero ignorabile
    // lo si logga spiegando perché). Qui `cookies()` lancia solo fuori da un
    // contesto di richiesta — i ~90 test API con una `Request` nuda — e il ramo
    // giusto è proprio «nessuna sessione». Ma se questa riga comparisse in
    // PRODUZIONE vorrebbe dire che la lettura della sessione è rotta per tutti, e
    // senza il log l'unico sintomo sarebbe un'app che rimanda al login senza
    // motivo apparente. È la stessa scelta, con le stesse parole, di `me:GET`.
    logEvento('auth', 'info', { operazione: 'resolveIdentity', esito: 'sessione-non-leggibile' }, err)
    sessionUid = null
  }
  if (sessionUid) {
    // `catch` che degrada a «niente riga, niente ponte»: `createAdminClient()` può
    // lanciare (config assente), e un gate non deve morire per questo — ma nemmeno
    // tacere, perché senza identità applicativa ogni route risponderà 403.
    const risolto = await risolviDaAuthUid(sessionUid).catch((err) => {
      logEvento('auth', 'error', { operazione: 'resolveIdentity', esito: 'lookup-identita-fallito' }, err)
      return { appId: null, rigaUtenti: null, ponteGenitore: false }
    })
    return {
      userId: risolto.appId ?? sessionUid,
      source: 'session',
      rigaUtenti: risolto.rigaUtenti,
      ponteGenitore: risolto.ponteGenitore,
    }
  }
  // 2) Fallback legacy (header/query), salvo disabilitazione esplicita.
  if (process.env.ALLOW_HEADER_IDENTITY !== 'false') {
    const headerId = getRequestUserId(request)
    if (headerId) {
      // Osservabilità rollout (S13): traccia quanto si usa ancora il path legacy senza
      // sessione. Quando questi log scendono a ~0, è sicuro mettere il flag a 'false'.
      //
      // È a livello `warn`, quindi finisce in TABELLA — e va lì di proposito: «l'identità è
      // stata presa da un header invece che dalla sessione» non è rumore operativo, è un
      // segnale di sicurezza (i dinieghi dei gate qui sotto sono `info`), ed è il contatore
      // su cui si decide se sigillare l'auth. Un contatore che vive solo su Vercel (un giorno
      // di ritenzione, nessun SQL) non si può né contare né vedere scendere nel tempo.
      //
      // NIENTE `path`: il contesto della richiesta ce l'ha già, NORMALIZZATO. Quello grezzo
      // — `new URL(request.url).pathname` — porta il token del modulo pubblico (`/m/<token>`
      // è una capability) e non lo si vuole in una riga che, per giunta, si persiste.
      // La chiave è `tipo` e non `motivo`: `redact()` è a lista bianca PER CHIAVE, `motivo`
      // non è in lista, e in tabella sarebbe uscito `[redatto:str/15]` — cioè la riga non
      // avrebbe più detto QUALE segnale era. (Verificato, non supposto.)
      logEvento('auth', 'warn', { tipo: 'header-fallback' })
      return { userId: headerId, source: 'header' }
    }
  }
  return { userId: null, source: null }
}

/**
 * Risolve l'id applicativo dalla SOLA sessione (cookie Supabase), per i
 * server component che non hanno una `Request` (es. pagine). Nessun percorso
 * header/query e nessun fallback demo: `null` = anonimo.
 */
export async function resolveSessionAppId(): Promise<string | null> {
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    const uid = data?.user?.id ?? null
    if (!uid) return null
    const { appId } = await risolviDaAuthUid(uid)
    return appId ?? uid
  } catch (err) {
    // `null` = anonimo, ed è il ripiego giusto per un server component: al peggio si
    // torna al login. Ma «anonimo» e «la lettura della sessione è rotta» sono due
    // fatti diversi che qui producono lo stesso valore: senza questa riga la
    // differenza non esisterebbe da nessuna parte (AGENTS regola 6).
    logEvento('auth', 'info', { operazione: 'resolveSessionAppId', esito: 'sessione-non-leggibile' }, err)
    return null
  }
}

/**
 * Proiezione PURA da riga `utenti` ad `AppUser`. È l'unico punto che decide come
 * una riga diventa un utente applicativo: la usano sia `loadAppUser` (che la riga
 * la legge) sia i gate (che ce l'hanno già in mano da `resolveIdentity`).
 *
 * NON imposta `ruoli`: il default di `ruoliDi` è già `[role]`, cioè la semantica
 * esatta di oggi. Per i 617 utenti con un ruolo solo l'oggetto resta identico campo
 * per campo a quello di prima — che è il modo più forte di garantire che non cambi
 * niente per loro. Il secondo ruolo lo aggiunge `conPonteGenitore`, e solo quando c'è.
 */
function proiettaAppUser(riga: RigaUtenti): AppUser {
  return {
    id: riga.id,
    role: (riga.role || riga.ruolo) as AppRole,
    nome: riga.nome,
    cognome: riga.cognome,
    scuola_id: riga.scuola_id,
  }
}

/**
 * Carica l'utente applicativo da `utenti` (tabella reale: il DB non usa
 * Supabase Auth, `utenti.id ≠ auth.uid()`). Usa il client service-role perché
 * è il pattern di tutta la codebase; l'enforcement è applicativo.
 *
 * ⚠️ IL CONTRATTO VERSO L'ESTERNO NON CAMBIA, e non è una cautela generica: la
 * chiama anche `/api/primaria/me`, che alimenta `isDirigente`, `useTeacherGradi` e
 * `admin-identity`. Lì serve il ruolo DI LAVORO, non la veste indossata: un
 * docente-genitore in modalità genitore che si vedesse tornare `ruolo:'genitore'`
 * da quella route troverebbe la navigazione docente svuotata. Il ruolo attivo lo
 * applicano i GATE, che sanno di stare rispondendo a una richiesta.
 */
export async function loadAppUser(userId: string): Promise<AppUser | null> {
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('utenti')
    .select(COLONNE_UTENTE)
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return proiettaAppUser(data as RigaUtenti)
}

/**
 * Aggiunge `genitore` ai ruoli reali quando il ponte `parents.auth_user_id` esiste.
 *
 * Idempotente e conservativo: se il ponte non c'è, o se la persona è GIÀ un
 * genitore in `utenti` (il caso dedup di `getProfiliForAuthUid`), restituisce
 * l'oggetto ORIGINALE — stessa identità di riferimento, nessun campo nuovo.
 */
function conPonteGenitore(user: AppUser, ponte: boolean): AppUser {
  if (!ponte) return user
  const ruoli = ruoliDi(user)
  if (ruoli.includes('genitore')) return user
  return { ...user, ruoli: [...ruoli, 'genitore'] }
}

/**
 * Il ruolo ATTIVO applicato all'utente, per questa richiesta.
 *
 * TRE CONDIZIONI, e ognuna toglie una strada a chi volesse usare il cookie come
 * un ingresso:
 *
 * 1. SOLO CON `source === 'session'`. `resolveIdentity` ammette ancora il percorso
 *    legacy `x-user-id`/`?userId=` finché `ALLOW_HEADER_IDENTITY !== 'false'`.
 *    «Cookie del browser A + header con l'id di B» è una combinazione che nessuno
 *    può provare legittima: lì il ruolo attivo si ignora e vale `utenti.ruolo`.
 *    ⚠️ OGGI QUESTA RIGA È LA SECONDA CINTURA, non la prima, e va detto per intero
 *    perché nessuno la tolga credendola morta: il percorso header non legge il
 *    ponte, quindi arriva qui sempre con un ruolo solo e il `return` di sotto
 *    scatterebbe comunque. Misurato con due mutazioni deliberate (vedi il commento
 *    gemello in `ruolo-attivo.test.ts`): far riportare il ponte anche al percorso
 *    header NON cambia la veste finché questa riga c'è, e la cambia appena la si
 *    toglie. È la differenza fra «è sicuro» e «è sicuro per come stanno le cose ora».
 * 2. SOLO FRA I RUOLI REALI. `risolviRuoloAttivo` scarta un cookie che nomini un
 *    ruolo che la persona non ha — e li rilegge a OGNI richiesta, quindi un ruolo
 *    REVOCATO fa decadere il cookie subito invece che fra 180 giorni.
 * 3. NON È MAI UN INGRESSO. I gate qui sotto verificano `haUnRuolo` sui ruoli
 *    reali, non su questa veste.
 *
 * Con un ruolo solo esce subito: nessun costo e nessun rischio per i 617 utenti
 * non doppi, che non hanno niente da scegliere.
 */
function conRuoloAttivo(user: AppUser, request: Request, source: IdentitySource | null): AppUser {
  if (source !== 'session') return user
  const ruoli = ruoliDi(user)
  if (ruoli.length < 2) return user
  const cookie = leggiCookie(request.headers.get('cookie'), ACTIVE_ROLE_COOKIE)
  const attivo = risolviRuoloAttivo(ruoli.map((ruolo) => ({ ruolo })), cookie) ?? user.role
  return attivo === user.role ? user : { ...user, role: attivo }
}

/**
 * Identità della richiesta → utente applicativo con i suoi ruoli REALI e la veste
 * attiva. È il cuore condiviso dai quattro gate: prima stava copiato in ognuno.
 *
 * Restituisce `userId` e `user` separatamente perché i tre motivi di diniego sono
 * tre cose diverse e i gate li distinguono: nessuna identità (401), identità che
 * non corrisponde a nessun utente (403/401), ruolo non ammesso (403).
 */
async function utenteDellaRichiesta(
  request: Request,
): Promise<{ userId: string | null; user: AppUser | null }> {
  const ident = await resolveIdentity(request)
  if (!ident.userId) return { userId: null, user: null }

  // La riga già letta vale SOLO se è la stessa che `loadAppUser` andrebbe a leggere
  // (`utenti.id === userId`): quando `userId` viene dal ponte (`parents.id`) o è
  // l'uid grezzo, `loadAppUser` cerca un'ALTRA riga, e saltare la lettura
  // cambierebbe il risultato invece di risparmiarlo. Si pretende anche che la riga
  // porti un ruolo: senza, non è un utente applicativo ma un mezzo record.
  const gia = ident.rigaUtenti
  const riusabile = gia && gia.id === ident.userId && (gia.role || gia.ruolo) ? gia : null

  const letto = riusabile ? proiettaAppUser(riusabile) : await loadAppUser(ident.userId)
  if (!letto) return { userId: ident.userId, user: null }

  const conRuoli = conPonteGenitore(letto, ident.ponteGenitore === true)
  return { userId: ident.userId, user: conRuoloAttivo(conRuoli, request, ident.source) }
}

/* ────────────────────────────────────────────────────────────────────────────
 * OSSERVABILITÀ DEI GATE (Task 7)
 *
 * I gate sono gli unici punti del sistema che hanno in mano `userId`, `ruolo` e `scuola_id`
 * PRIMA che la route faccia qualunque cosa. Depositandoli nel contesto, quei tre campi
 * finiscono in OGNI riga di log della richiesta (`rid uid ruolo sede`), senza che 211 route
 * debbano ricordarsi di passarli — ed è ciò che rende una riga di errore attribuibile a una
 * persona e a una sede invece che al nulla.
 *
 * IL LIVELLO DEI DINIEGHI: `info`, non `warn`. Non è timidezza, è aritmetica:
 * `vaPersistito()` manda in TABELLA tutto ciò che è `warn` o `error`, e i 401/403 sono gli
 * eventi più frequenti che un'app autenticata produca — ogni cookie scaduto, ogni pagina
 * protetta riaperta il mattino dopo ne genera a raffica. A `warn`, `app_log` diventerebbe una
 * tabella di dinieghi innocui in cui i guasti veri non si trovano più: si sarebbe pagato un
 * log per accecarne un altro. `with-route.ts` ha già affrontato la stessa scelta e ha deciso
 * così (401/403/404 → `info`; le ANOMALIE 408/409/413/429 → `warn`), e qui si resta coerenti:
 * i dinieghi restano visibili su Vercel, che è dove si guarda un «perché mi dà 403».
 *
 * L'ECCEZIONE è `header-fallback` (vedi `resolveIdentity`): non è un diniego, è un segnale di
 * sicurezza, ed è `warn` — persistito. Stessa ragione per i due `warn` di
 * `risolviDaAuthUid`: «non ho potuto leggere chi sei» non è un diniego, è un guasto.
 *
 * Perché una riga in più quando `withRoute` già logga il 403: `withRoute` sa che la route ha
 * risposto 403, non sa PERCHÉ. Questa riga porta il motivo (ruolo non ammesso? utente
 * inesistente? nessuna identità?), il gate che ha negato e il ruolo effettivo: è la differenza
 * fra «ha ricevuto un 403» e «un `genitore` ha bussato a una route staff».
 * ──────────────────────────────────────────────────────────────────────────── */

/** Perché il gate ha detto no. Chiave `tipo`: è in lista bianca, sopravvive a `redact()`. */
type MotivoDiniego = 'non-autenticato' | 'utente-sconosciuto' | 'ruolo-negato'

/** Il testo del 401 è identico in tutti e quattro i gate: i client lo confrontano. Non cambiarlo. */
const NON_AUTENTICATO = 'Non autenticato: userId mancante'

/**
 * Il testo del 403 di `requireStaff` DIPENDE DA CHI È AMMESSO — e non è una
 * finezza di cortesia.
 *
 * Misurato il 2026-07-31 (collaudo frontend F1): la segreteria apriva il
 * dettaglio di una sezione e leggeva «Accesso negato: operazione riservata allo
 * staff». Ma la segreteria È staff — sta nel default di questo stesso gate, per
 * il PRD §3 che equipara Segreteria↔Admin. Il messaggio era falso: la funzione
 * era riservata alla DIREZIONE, cioè alla lista esplicita `['admin','coordinator']`
 * che quella route passava.
 *
 * Un diniego è l'UNICA informazione che l'operatore ha per decidere se chiedere
 * un permesso o segnalare un guasto. Detto male, produce segnalazioni che
 * nessuno può chiudere — «dice che è per lo staff e io sono staff».
 *
 * La regola è meccanica, così non può tornare a mentire: se fra gli ammessi c'è
 * `segreteria` il gate è quello dello staff di gestione; se non c'è, resta la
 * sola Direzione (`admin`/`coordinator`), che è la forma usata dalle operazioni
 * di dirigenza legate alla FEA.
 */
export function messaggioNegatoStaff(allowed: readonly StaffRole[]): string {
  return allowed.includes('segreteria')
    ? 'Accesso negato: operazione riservata allo staff'
    : 'Accesso negato: operazione riservata alla Direzione'
}

/**
 * Identità nel contesto e via: da qui in poi ogni riga di log della richiesta porta
 * `uid`/`ruolo`/`sede`. `impostaUtente` accetta `null` (`scuola_id` è opzionale) ed è un
 * no-op fuori da una richiesta: nei ~90 test API che invocano gli handler con una `Request`
 * nuda non c'è nessun contesto aperto, e non deve succedere nulla.
 */
function concedi(user: AppUser): AuthResult {
  impostaUtente({ userId: user.id, ruolo: user.role, scuolaId: user.scuola_id })
  return { user }
}

/**
 * Il diniego, loggato e restituito. L'identità si deposita ANCHE qui quando la conosciamo
 * (403 da ruolo non ammesso): è la stessa persona, e senza `uid` nel contesto la riga di
 * esito di `withRoute` direbbe «403» senza dire a chi — cioè la metà meno utile della frase.
 *
 * `azione` (non `gate`) per il nome del gate, per la stessa ragione di `tipo` (non `motivo`):
 * sono le chiavi che `redact()` lascia in chiaro. Il livello `info` non persiste OGGI, ma una
 * riga leggibile su un canale solo è un bug che aspetta di essere scoperto.
 */
function nega(
  azione: string,
  stato: 401 | 403,
  tipo: MotivoDiniego,
  messaggio: string,
  user?: AppUser,
): AuthResult {
  if (user) impostaUtente({ userId: user.id, ruolo: user.role, scuolaId: user.scuola_id })
  // `logEvento` è fail-open per costruzione: non serve un try qui attorno, e un gate di
  // sicurezza non può comunque essere fatto fallire da un logger.
  //
  // `ruolo` è quello ATTIVO — la veste con cui la persona ha bussato — ed è ciò che serve
  // per capire un diniego. `doppio` dice che dietro quella veste ce n'è un'altra, cioè che
  // il 403 potrebbe essere «sta guardando l'app dal lato sbagliato» e non «non può».
  // COMPARE SOLO QUANDO È VERO: questa riga si scrive a OGNI 401/403 — gli eventi più
  // frequenti che un'app autenticata produca — e un `doppio: false` costante è rumore che
  // non dice niente, mentre l'assenza dice già «persona con una sola veste». È un booleano,
  // quindi passa la lista bianca di `redact()` senza aggiungere chiavi nuove.
  const doppio = user && ruoliDi(user).length > 1 ? true : undefined
  logEvento('auth', 'info', { tipo, azione, ruolo: user?.role, doppio })
  return { response: NextResponse.json({ error: messaggio }, { status: stato }) }
}

/**
 * L'identità dalla SOLA sessione Supabase, con l'uid di `auth.users` e l'email.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ NON È `requireUser`, E LA DIFFERENZA È IL MOTIVO PER CUI ESISTE.
 *
 * `resolveIdentity` — su cui poggiano tutti e quattro i gate qui sopra — onora ancora
 * il percorso legacy `x-user-id`/`?userId=` finché `ALLOW_HEADER_IDENTITY !== 'false'`.
 * In produzione quella variabile vale `'false'`, e va benissimo per le route che
 * leggono o scrivono dati: se saltasse, il danno sarebbe grave ma circoscritto.
 *
 * Non va bene per una route che RISCRIVE LA PASSWORD di chiunque. Lì l'unica difesa
 * non può essere una variabile d'ambiente: basta un ambiente nuovo, un `.env`
 * incompleto o una preview mal configurata, e un header solo cambierebbe la password
 * di 560 account — cioè chiuderebbe fuori dal proprio registro 560 famiglie, in una
 * richiesta. Questo gate l'header non lo legge affatto: non ha nemmeno il parametro
 * `request`, quindi non c'è niente da cui possa prenderlo. È un divieto di forma, non
 * una condizione da valutare.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESTITUISCE L'UID DI **AUTH**, NON L'ID APPLICATIVO.
 *
 * `utenteDellaRichiesta` mappa `auth.uid()` sull'id applicativo, e per un genitore
 * quello è `parents.id` — una riga di ANAGRAFICA, che con `auth.users` non ha niente
 * a che vedere: il ponte è `parents.auth_user_id`. Confondere i due è un errore già
 * pagato in questo repo, ed è scritto per esteso in
 * `src/app/api/parent/onboarding/route.ts:132-138` («0 genitori su 46 risultavano
 * onboardati, perché ogni update qui aggiornava zero righe e rispondeva comunque
 * successo»). Chi chiama `admin.auth.admin.updateUserById` ha bisogno proprio
 * dell'uid di auth: qualunque altra cosa scriverebbe la password di nessuno,
 * dichiarando successo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'EMAIL viene da GoTrue, non dal client. È l'unico modo di verificare la password
 * attuale (`signInWithPassword` vuole un indirizzo), e prenderla dal corpo della
 * richiesta significherebbe permettere a chi chiama di provare le password di
 * qualcun altro attraverso il nostro server — un oracolo di password con la nostra
 * faccia. Se la sessione non porta un'email (account creato solo con telefono), il
 * chiamante è autenticato ma la verifica non è possibile: lo decide la route.
 *
 * Il `nega` è quello condiviso: stesso testo di 401 degli altri quattro gate (i client
 * lo confrontano) e stessa riga di log, senza aggiungere una seconda risposta d'errore
 * scritta a mano in questo file.
 */
export async function requireSessioneAuth(): Promise<
  | { response: NextResponse; sessione?: never }
  | { response?: never; sessione: { authUserId: string; email: string | null; accessToken: string | null } }
> {
  let authUserId: string | null = null
  let email: string | null = null
  let accessToken: string | null = null

  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    // PostgREST non lancia, e nemmeno GoTrue: l'errore torna nel valore. Livello
    // `info` per la stessa ragione di `resolveIdentity` — «non c'è sessione» è la
    // risposta normale di ogni richiesta anonima, e a `warn` riempirebbe la tabella.
    if (error) {
      logEvento('auth', 'info', { operazione: 'requireSessioneAuth', esito: 'sessione-non-leggibile' }, error)
    }
    authUserId = data?.user?.id ?? null
    email = data?.user?.email ?? null
    if (authUserId) {
      // Il token della PROPRIA sessione. Non serve all'identità — quella l'ha già
      // stabilita `getUser()`, che la verifica col server — ma è ciò che serve a chi
      // debba agire sulle altre sessioni della stessa persona (`auth.admin.signOut`).
      // Letto qui perché è l'unico punto che ha in mano il client di sessione.
      const { data: sessione } = await supabase.auth.getSession()
      accessToken = sessione?.session?.access_token ?? null
    }
  } catch (err) {
    // `createClient()`/`cookies()` lancia fuori da un contesto di richiesta (i ~90
    // test API con una `Request` nuda). Il ramo giusto è «nessuna sessione», e si
    // logga invece di tacere: se questa riga comparisse in PRODUZIONE vorrebbe dire
    // che la lettura della sessione è rotta per tutti, e l'unico sintomo sarebbe un
    // rimando al login senza motivo apparente (AGENTS regola 6).
    logEvento('auth', 'info', { operazione: 'requireSessioneAuth', esito: 'sessione-non-leggibile' }, err)
    authUserId = null
  }

  if (!authUserId) {
    // `nega` restituisce sempre il ramo con la response; il `!` è per il tipo unione.
    const rifiuto = nega('requireSessioneAuth', 401, 'non-autenticato', NON_AUTENTICATO)
    return { response: rifiuto.response! }
  }

  impostaUtente({ userId: authUserId })
  return { sessione: { authUserId, email, accessToken } }
}

/**
 * Garantisce che la richiesta provenga da un membro dello staff di gestione.
 * Default: `admin`/`coordinator`/`segreteria` (la Segreteria ha la dashboard
 * gestionale completa — anagrafe, iscrizioni, pagamenti, impostazioni — coerente
 * col PRD §3 che equipara Segreteria↔Admin). Enforcement APPLICATIVO: legge l'id
 * dalla richiesta (`x-user-id`/`?userId=`) e ne verifica il ruolo su `utenti`.
 *
 * ⚠️ Le operazioni di DIRIGENZA legate alla firma FEA (chiusura/pubblicazione
 * scrutinio, generazione pagella ufficiale, sblocco time-lock) NON usano questo
 * default: passano la lista esplicita `['admin','coordinator']`, così la
 * Segreteria resta esclusa (vincolo O.M. 3/2025 + FEA).
 *
 * 🔒 IDENTITÀ (P0): l'id è risolto da `resolveIdentity()` che preferisce la
 * sessione Supabase Auth (`auth.uid()`); l'header `x-user-id` è ignorato se ≠
 * sessione (anti-spoof) e ammesso solo come fallback legacy finché
 * `ALLOW_HEADER_IDENTITY !== 'false'` (sigillato a fine P0). Per lo staff vale
 * `utenti.id == auth.uid()`; la RLS forte sulle letture genitore è in S8/S9.
 *
 * 🔒 IL CONFRONTO È SUI RUOLI REALI (`haUnRuolo`), non sul ruolo attivo: il cookie
 * `kv-active-role` sceglie una vista, non apre una porta. Conseguenza voluta:
 * passare in modalità genitore NON chiude fuori dalle API di gestione — niente 403
 * misteriosi in un'altra scheda del browser mentre si cambia veste.
 *
 * Uso:
 * ```ts
 * const auth = await requireStaff(request)            // staff gestione (incl. segreteria)
 * const auth = await requireStaff(request, ['admin','coordinator'])  // solo dirigenza
 * if (auth.response) return auth.response
 * const staffId = auth.user.id
 * ```
 */
export async function requireStaff(
  request: Request,
  allowed: StaffRole[] = ['admin', 'coordinator', 'segreteria']
): Promise<AuthResult> {
  const NEGATO = messaggioNegatoStaff(allowed)
  const { userId, user } = await utenteDellaRichiesta(request)
  if (!userId) return nega('requireStaff', 401, 'non-autenticato', NON_AUTENTICATO)

  if (!user) return nega('requireStaff', 403, 'utente-sconosciuto', NEGATO)
  if (!haUnRuolo(user, allowed)) {
    return nega('requireStaff', 403, 'ruolo-negato', NEGATO, user)
  }

  return concedi(user)
}

/**
 * Garantisce accesso in SOLA LETTURA al modulo cucina (menu/report mensa).
 * Ammessi: admin, coordinator, segreteria, cuoca (tutte le classi) e educator
 * (che però deve restare scoped alla propria sezione, da applicare in query).
 * La segreteria è inclusa perché gestisce lo sportello (PRD §3: segreteria≈admin):
 * dopo un inserimento pasto fuori orario deve poter verificare il report cucina.
 * Le SCRITTURE restano riservate a `requireStaff`.
 */
export async function requireKitchenRead(
  request: Request,
  allowed: AppRole[] = ['admin', 'coordinator', 'segreteria', 'cuoca', 'educator']
): Promise<AuthResult> {
  const NEGATO = 'Accesso negato: operazione riservata a cucina/staff'
  const { userId, user } = await utenteDellaRichiesta(request)
  if (!userId) return nega('requireKitchenRead', 401, 'non-autenticato', NON_AUTENTICATO)

  if (!user) return nega('requireKitchenRead', 403, 'utente-sconosciuto', NEGATO)
  if (!haUnRuolo(user, allowed)) {
    return nega('requireKitchenRead', 403, 'ruolo-negato', NEGATO, user)
  }
  return concedi(user)
}

/**
 * Garantisce che la richiesta provenga da un utente autenticato qualsiasi
 * (qualsiasi ruolo). Per route lette dal genitore: lo scoping ai propri figli
 * va poi fatto in query via `legame_genitori_alunni`.
 */
export async function requireUser(request: Request): Promise<AuthResult> {
  const { userId, user } = await utenteDellaRichiesta(request)
  if (!userId) return nega('requireUser', 401, 'non-autenticato', NON_AUTENTICATO)

  // NB: qui l'utente sconosciuto è un 401 (non un 403) — «non so chi sei», non «non puoi».
  // Lo status è quello di prima: i client lo distinguono.
  if (!user) return nega('requireUser', 401, 'utente-sconosciuto', 'Utente non trovato')
  // Nessun controllo di ruolo: questo gate chiede solo «chi sei». È l'unico dei quattro
  // che resta identico riga per riga — non ha una lista di ammessi da confrontare.
  return concedi(user)
}

/**
 * Garantisce che la richiesta provenga dal personale DOCENTE/segreteria
 * (`educator`/`admin`/`coordinator`/`segreteria`). Esclude esplicitamente
 * `genitore` e `cuoca`.
 *
 * Da usare per le route docente che leggono/scrivono dati di classe o riservati
 * (registro, note, prospetto/medie, annotazioni): nel modello app-level un
 * genitore possiede un `userId` valido e, senza questo gate, potrebbe raggiungerle
 * chiamandole con il proprio id. Enforcement applicativo (vedi requireStaff).
 *
 * ⚠️ Il gate verifica SOLO il ruolo: NON applica scoping per plesso/classe. Dopo
 * il gate va sempre chiamato lo scope (`assertSezioneInScope`/`assertAlunnoInScope`
 * in `@/lib/auth/scope`) per impedire accessi cross-tenant e, per `educator`,
 * fuori dalle sezioni assegnate.
 *
 * 🔒 Il confronto è sui ruoli REALI (`haUnRuolo`). Un genitore puro con un cookie
 * `kv-active-role=educator` forgiato resta fuori: `educator` non è fra i suoi ruoli
 * di database, quindi il cookie non viene nemmeno onorato. Un docente-genitore in
 * veste di genitore, invece, passa — perché `educator` lo è davvero.
 *
 * Uso:
 * ```ts
 * const auth = await requireDocente(request)
 * if (auth.response) return auth.response
 * const userId = auth.user.id
 * ```
 */
export async function requireDocente(
  request: Request,
  allowed: AppRole[] = ['educator', 'admin', 'coordinator', 'segreteria']
): Promise<AuthResult> {
  const NEGATO = 'Accesso negato: riservato al personale docente'
  const { userId, user } = await utenteDellaRichiesta(request)
  if (!userId) return nega('requireDocente', 401, 'non-autenticato', NON_AUTENTICATO)

  if (!user) return nega('requireDocente', 403, 'utente-sconosciuto', NEGATO)
  if (!haUnRuolo(user, allowed)) {
    return nega('requireDocente', 403, 'ruolo-negato', NEGATO, user)
  }
  return concedi(user)
}
