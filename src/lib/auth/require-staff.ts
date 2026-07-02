import { NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'

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
      // Osservabilità rollout (S13): traccia quanto si usa ancora il path legacy
      // senza sessione. Quando questi log scendono a ~0, è sicuro mettere il flag a 'false'.
      let path = ''
      try {
        path = new URL(request.url).pathname
      } catch {
        /* no-op */
      }
      console.warn(`[auth][header-fallback] identità da header/query (nessuna sessione) path=${path}`)
      return { userId: headerId, source: 'header' }
    }
  }
  return { userId: null, source: null }
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
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return {
      response: NextResponse.json(
        { error: 'Non autenticato: userId mancante' },
        { status: 401 }
      ),
    }
  }

  const user = await loadAppUser(userId)
  if (!user || !allowed.includes(user.role as StaffRole)) {
    return {
      response: NextResponse.json(
        { error: 'Accesso negato: operazione riservata allo staff' },
        { status: 403 }
      ),
    }
  }

  return { user }
}

/**
 * Garantisce accesso in SOLA LETTURA al modulo cucina (menu/report mensa).
 * Ammessi: admin, coordinator, cuoca (tutte le classi) e educator (che però
 * deve restare scoped alla propria sezione, da applicare in query).
 * Le SCRITTURE restano riservate a `requireStaff` (admin/coordinator).
 */
export async function requireKitchenRead(
  request: Request,
  allowed: AppRole[] = ['admin', 'coordinator', 'cuoca', 'educator']
): Promise<AuthResult> {
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return {
      response: NextResponse.json(
        { error: 'Non autenticato: userId mancante' },
        { status: 401 }
      ),
    }
  }
  const user = await loadAppUser(userId)
  if (!user || !allowed.includes(user.role)) {
    return {
      response: NextResponse.json(
        { error: 'Accesso negato: operazione riservata a cucina/staff' },
        { status: 403 }
      ),
    }
  }
  return { user }
}

/**
 * Garantisce che la richiesta provenga da un utente autenticato qualsiasi
 * (qualsiasi ruolo). Per route lette dal genitore: lo scoping ai propri figli
 * va poi fatto in query via `legame_genitori_alunni`.
 */
export async function requireUser(request: Request): Promise<AuthResult> {
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return {
      response: NextResponse.json(
        { error: 'Non autenticato: userId mancante' },
        { status: 401 }
      ),
    }
  }
  const user = await loadAppUser(userId)
  if (!user) {
    return {
      response: NextResponse.json({ error: 'Utente non trovato' }, { status: 401 }),
    }
  }
  return { user }
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
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return {
      response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
    }
  }
  const user = await loadAppUser(userId)
  if (!user || !allowed.includes(user.role)) {
    return {
      response: NextResponse.json({ error: 'Accesso negato: riservato al personale docente' }, { status: 403 }),
    }
  }
  return { user }
}
