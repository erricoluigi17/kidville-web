import { NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { impostaUtente } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'

export type StaffRole = 'admin' | 'coordinator' | 'segreteria'
export type AppRole = 'admin' | 'coordinator' | 'educator' | 'segreteria' | 'genitore' | 'cuoca'

export interface AppUser {
  id: string
  role: AppRole
  nome?: string | null
  cognome?: string | null
  scuola_id?: string | null
}

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

/**
 * Mappa un `auth.uid()` (Supabase Auth) all'id applicativo.
 * - Staff: `utenti.id == auth.uid()` (la PK di `utenti` è FK → `auth.users`).
 * - Genitori: `parents.auth_user_id == auth.uid()` (ponte aggiunto in P0/S4).
 * Restituisce `null` se nessuno combacia (o se la colonna ponte non esiste ancora).
 */
async function resolveAppIdFromAuthUid(authUid: string): Promise<string | null> {
  const supabase = await createAdminClient()
  const { data: staff } = await supabase
    .from('utenti')
    .select('id')
    .eq('id', authUid)
    .maybeSingle()
  if (staff?.id) return staff.id
  const { data: parent } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authUid)
    .maybeSingle()
  if (parent?.id) return parent.id
  return null
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
 */
export async function resolveIdentity(
  request: Request
): Promise<{ userId: string | null; source: IdentitySource | null }> {
  // 1) Sessione reale. Avvolto in try/catch: createClient()/cookies() lancia
  //    fuori da un contesto di richiesta (e può non essere mockato in alcuni unit test).
  let sessionUid: string | null = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    sessionUid = data?.user?.id ?? null
  } catch {
    sessionUid = null
  }
  if (sessionUid) {
    const appId = await resolveAppIdFromAuthUid(sessionUid).catch(() => null)
    return { userId: appId ?? sessionUid, source: 'session' }
  }
  // 2) Fallback legacy (header/query), salvo disabilitazione esplicita.
  if (process.env.ALLOW_HEADER_IDENTITY !== 'false') {
    const headerId = getRequestUserId(request)
    if (headerId) {
      // Osservabilità rollout (S13): traccia quanto si usa ancora il path legacy senza
      // sessione. Quando questi log scendono a ~0, è sicuro mettere il flag a 'false'.
      //
      // È l'UNICO log di questo file a livello `warn`, quindi l'unico che finisce in
      // TABELLA — e va lì di proposito: «l'identità è stata presa da un header invece che
      // dalla sessione» non è rumore operativo, è un segnale di sicurezza, ed è il contatore
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
    const appId = await resolveAppIdFromAuthUid(uid).catch(() => null)
    return appId ?? uid
  } catch {
    return null
  }
}

/**
 * Carica l'utente applicativo da `utenti` (tabella reale: il DB non usa
 * Supabase Auth, `utenti.id ≠ auth.uid()`). Usa il client service-role perché
 * è il pattern di tutta la codebase; l'enforcement è applicativo.
 */
export async function loadAppUser(userId: string): Promise<AppUser | null> {
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('utenti')
    .select('id, nome, cognome, ruolo, role, scuola_id')
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return {
    id: data.id,
    role: (data.role || data.ruolo) as AppRole,
    nome: data.nome,
    cognome: data.cognome,
    scuola_id: data.scuola_id,
  }
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
 * sicurezza, ed è `warn` — persistito.
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
  logEvento('auth', 'info', { tipo, azione, ruolo: user?.role })
  return { response: NextResponse.json({ error: messaggio }, { status: stato }) }
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
  const NEGATO = 'Accesso negato: operazione riservata allo staff'
  const { userId } = await resolveIdentity(request)
  if (!userId) return nega('requireStaff', 401, 'non-autenticato', NON_AUTENTICATO)

  const user = await loadAppUser(userId)
  if (!user) return nega('requireStaff', 403, 'utente-sconosciuto', NEGATO)
  if (!allowed.includes(user.role as StaffRole)) {
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
  const { userId } = await resolveIdentity(request)
  if (!userId) return nega('requireKitchenRead', 401, 'non-autenticato', NON_AUTENTICATO)

  const user = await loadAppUser(userId)
  if (!user) return nega('requireKitchenRead', 403, 'utente-sconosciuto', NEGATO)
  if (!allowed.includes(user.role)) {
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
  const { userId } = await resolveIdentity(request)
  if (!userId) return nega('requireUser', 401, 'non-autenticato', NON_AUTENTICATO)

  const user = await loadAppUser(userId)
  // NB: qui l'utente sconosciuto è un 401 (non un 403) — «non so chi sei», non «non puoi».
  // Lo status è quello di prima: i client lo distinguono.
  if (!user) return nega('requireUser', 401, 'utente-sconosciuto', 'Utente non trovato')
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
  const { userId } = await resolveIdentity(request)
  if (!userId) return nega('requireDocente', 401, 'non-autenticato', NON_AUTENTICATO)

  const user = await loadAppUser(userId)
  if (!user) return nega('requireDocente', 403, 'utente-sconosciuto', NEGATO)
  if (!allowed.includes(user.role)) {
    return nega('requireDocente', 403, 'ruolo-negato', NEGATO, user)
  }
  return concedi(user)
}
