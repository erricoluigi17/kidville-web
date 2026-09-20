import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
// Dal modulo dei predicati PURI, non da `require-staff`: 296 file di test
// sostituiscono quest'ultimo per intero, e il predicato sparirebbe col mock.
import { profiloStaffRevocato } from '@/lib/auth/predicati-ruolo'
import { areaForRole } from '@/lib/auth/active-role'
import type { Profilo } from '@/lib/auth/profili'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

// GET /api/me — profilo dell'utente corrente (gated, service-role server-side).
// Sostituisce le letture anon dirette di `utenti` (gallery docente, modulistica
// genitore). Non espone mai segreti (password_segreta/password).
//
// M4B.1: espone anche `profili: [{ ruolo, area }]` (doppio profilo da `utenti`
// + ponte `parents.auth_user_id`) e garantisce `role` al top-level (contratto
// retro-compatibile). Un genitore reale non ha una riga in `utenti` (vedi
// src/lib/auth/profili.ts) e non deve prendere 401.
//
// M9 (dedup M4B): la route faceva 6-8 round-trip (resolveIdentity: getUser +
// utenti + parents; poi utenti + parents di nuovo; getSessionProfili: getUser +
// utenti + parents). Ora sul percorso sessione: 1 getUser + 2 query PARALLELE
// (utenti per id=auth.uid, parents per auth_user_id=auth.uid) e i profili sono
// derivati dalle stesse due righe (stessa logica di getProfiliForAuthUid).
// Contratto e semantica dei 401 invariati.
const SECRETS = ['password_segreta', 'password', 'auth_user_id']

const getQuerySchema = z.object({}) // nessun parametro in ingresso

export const GET = withRoute('me:GET', async (request: Request) => {
  // 1) Sessione reale (stessa semantica di resolveIdentity: header ignorato se
  //    esiste una sessione). try/catch: cookies() lancia fuori da un contesto
  //    di richiesta o nei unit test senza mock.
  let authUid: string | null = null
  try {
    const sessionClient = await createClient()
    const { data } = await sessionClient.auth.getUser()
    authUid = data?.user?.id ?? null
  } catch (err) {
    // Errore IGNORABILE, e per questo si logga a `info` invece di tacere (AGENTS regola 6:
    // un catch che non logga è un bug; se un errore è davvero ignorabile, lo si logga
    // spiegando perché). Qui `cookies()` lancia solo fuori da un contesto di richiesta —
    // negli unit test senza mock — e il ramo giusto è proprio "nessuna sessione": si prosegue
    // con l'identità dall'header. Se un giorno questa riga comparisse in PRODUZIONE, però,
    // vorrebbe dire che la lettura della sessione è rotta per tutti, e senza il log
    // l'unico sintomo sarebbe un'app che rimanda al login senza motivo apparente.
    logEvento('auth', 'info', { operazione: 'me:GET', esito: 'sessione-non-leggibile' }, err)
    authUid = null
  }

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  let data: Record<string, unknown> | null = null
  let daParents = false
  let profili: Profilo[] = []

  if (authUid) {
    // Percorso sessione: 2 query parallele, niente lookup ripetuti.
    const [{ data: staff }, { data: parent }] = await Promise.all([
      supabase.from('utenti').select('*').eq('id', authUid).maybeSingle(),
      supabase.from('parents').select('*').eq('auth_user_id', authUid).maybeSingle(),
    ])
    /*
     * L'ARCHIVIAZIONE, E PERCHÉ VA GESTITA **QUI** E NON SOLO IN `profili.ts`.
     *
     * Questa route è la SECONDA copia della logica dei profili (vedi il commento
     * in cima: fu scritta a mano per togliere 6-8 round-trip). Toccando solo
     * `getProfiliForAuthUid` si costruisce un giro infinito, ed è stato
     * ricostruito riga per riga:
     *
     *   requireArea → profili vuoti → `/auth/login` → `signInWithPassword`
     *   RIESCE (GoTrue non sa niente di `archiviato_il`, e il cookie viene
     *   scritto) → `/api/me` → `profs = []` → `login/page.tsx` ripiega su
     *   `me.role`, che la riga `utenti` porta ancora → `router.replace('/teacher')`
     *   → requireArea → login. Senza un messaggio, e senza uscita.
     *
     * Il 403 col codice è l'unica cosa che rompe l'anello: la pagina di accesso
     * lo tratta già come guasto post-accesso e mostra la frase invece di navigare.
     *
     * ⚠️ Chi ha ANCHE il ponte non prende nessun 403: gli si toglie la veste da
     * staff e resta quella da genitore. Sono dodici persone al 2026-09-20.
     */
    const staffArchiviato = profiloStaffRevocato(
      (staff as { archiviato_il?: string | null } | null)?.archiviato_il,
    )
    if (staffArchiviato && !parent) {
      logEvento('auth', 'warn', { operazione: 'me:GET', esito: 'account-archiviato' })
      return NextResponse.json(
        { error: 'Accesso negato: questo accesso non è più attivo', codice: 'ACCOUNT_ARCHIVIATO' },
        { status: 403 },
      )
    }
    const staffVivo = staffArchiviato ? null : staff

    data = (staffVivo ?? parent) as Record<string, unknown> | null
    daParents = !staffVivo && !!parent

    // Profili derivati dalle stesse righe (logica di getProfiliForAuthUid:
    // ruolo staff + genitore dal ponte, dedup sul ruolo genitore).
    const ruoloStaff = (staffVivo?.role || staffVivo?.ruolo) as Profilo['ruolo'] | undefined
    if (ruoloStaff) profili.push({ ruolo: ruoloStaff, area: areaForRole(ruoloStaff) })
    if (parent && !profili.some((p) => p.ruolo === 'genitore')) {
      profili.push({ ruolo: 'genitore', area: 'parent' })
    }
  } else {
    // 2) Fallback legacy (header/query), salvo disabilitazione esplicita —
    //    stessa semantica di resolveIdentity, lookup per id applicativo.
    const headerId = process.env.ALLOW_HEADER_IDENTITY !== 'false' ? getRequestUserId(request) : null
    if (!headerId) {
      return NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 })
    }
    // `warn`, quindi in tabella: è il percorso legacy in cui l'identità arriva da un HEADER
    // invece che da una sessione firmata. Non è un guasto — la route funziona e risponde 200 —
    // ma è l'unico modo per CONTARE quanto ancora si usa e per accorgersi se comparisse in
    // produzione, dove sarebbe un problema di sicurezza, non una nota a piè di pagina.
    // Il path non serve come campo: `operazione` lo dice già, ed è la chiave con cui si cerca.
    logEvento('auth', 'warn', { operazione: 'me:GET', esito: 'header-fallback' })

    const { data: staff } = await supabase.from('utenti').select('*').eq('id', headerId).maybeSingle()
    data = staff as Record<string, unknown> | null
    if (!data) {
      const { data: parent } = await supabase.from('parents').select('*').eq('id', headerId).maybeSingle()
      if (parent) {
        data = parent as Record<string, unknown>
        daParents = true
      }
    }
  }

  if (!data) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })
  }

  const safe = { ...data }
  for (const k of SECRETS) delete safe[k]

  // `role` sempre presente al top-level (le righe `parents` non hanno ruolo).
  const role = (safe.role || safe.ruolo || (daParents ? 'genitore' : null)) as string | null

  // Percorso legacy senza sessione: profilo singolo dal ruolo della riga.
  if (!profili.length && role) {
    profili = [{ ruolo: role as Profilo['ruolo'], area: areaForRole(role) }]
  }

  return NextResponse.json({ ...safe, role, profili })
})
