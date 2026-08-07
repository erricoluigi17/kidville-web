import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AuthResult } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'

/**
 * Un uuid, per distinguere «id sbagliato» da «guasto di lettura». Sette delle
 * venti route che passano di qui validano `studentId` come stringa non vuota
 * (non `zUuid`): senza questa distinzione PostgREST risponderebbe `22P02` alla
 * verifica di scope, `assertAlunnoInScope` lo tratterebbe da guasto (500 +
 * `error` `scope-alunno-non-risolto`) e un contatore nato per segnalare un DB
 * rotto si riempirebbe di errori di battitura.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Gate per le route che leggono o scrivono i dati di UN alunno indicato dal
 * client — venti, di cui cinque in scrittura e una con valore legale (la firma
 * FES della giustifica).
 *
 * Chiude tre buchi, non uno:
 *  1. Auth-bypass (`?userId=` arbitrario): usa `requireUser` → `resolveIdentity`,
 *     che lega l'identità alla SESSIONE reale (con `ALLOW_HEADER_IDENTITY=false`
 *     l'header/query non è più accettato). 401 se non autenticato.
 *  2. IDOR sulla FAMIGLIA: il `genitore` deve avere il legame con l'alunno
 *     (`genitoreHasFiglio`, unione robusta `legame_genitori_alunni` +
 *     `student_parents` via ponte `parents.auth_user_id`). 403 altrimenti.
 *  3. IDOR fra SEDI e fra CLASSI: chiunque non sia genitore deve avere l'alunno
 *     nel proprio plesso e — se `educator` — nella propria sezione
 *     (`assertAlunnoInScope`).
 *
 * ⚠️ IL PUNTO 3 NON C'ERA, e fino al 2026-07-31 questa testata dichiarava il
 * contrario: «staff/educator passano: il loro scope è applicato altrove nelle
 * rispettive query». Contati uno per uno, i venti call site stavano così:
 * **diciotto non avevano nulla**; `gallery:GET` aveva il solo controllo di
 * PLESSO (non di sezione), aggiunto il giorno prima come tampone locale; e
 * `diary/students:GET` era l'unico con il gate completo, scritto a mano. Il
 * client è `createAdminClient()` (service-role), che scavalca la RLS: dove
 * l'altrove non c'era, non c'era nessuna difesa.
 *
 * Misurato in produzione, non dedotto: `GET /api/diary/entries?alunno_id=<minore
 * di Giugliano>` con la sessione di un educator di AVERSA rispondeva **200** con
 * il diario completo (bagno, pranzo, attività); `GET
 * /api/parent/primaria/assenze` restituiva le assenze col `giustificazione_testo`,
 * che è testo libero di natura sanitaria. Ripetuto su cinque minori e sette
 * attori — docenti e segreterie di altre sedi, e perfino la CUOCA: 200 per
 * tutti. L'unico 403 arrivava all'altro genitore. In `app_log` nemmeno un warn:
 * senza gate non esiste neppure il segnale che qualcuno ci ha provato.
 *
 * Il perimetro NON si stringe sui percorsi legittimi: l'educator continua a
 * vedere i bambini delle proprie sezioni, la segreteria tutte le classi del
 * proprio plesso, la Direzione tutti i plessi che ha in `utenti_scuole`. E al
 * genitore la sede non si applica affatto — due fratelli possono essere iscritti
 * in due plessi diversi, il suo scope è la famiglia.
 *
 * Uso (dopo aver risolto `studentId`, es. da `parseQuery`):
 * ```ts
 * const auth = await requireParentOfStudent(request, studentId)
 * if (auth.response) return auth.response
 * const userId = auth.user.id
 * ```
 */
export async function requireParentOfStudent(
  request: Request,
  studentId: string
): Promise<AuthResult> {
  const auth = await requireUser(request)
  if (auth.response) return auth

  const supabase = await createAdminClient()

  if (auth.user.role === 'genitore') {
    const ok = await genitoreHasFiglio(supabase, auth.user.id, studentId)
    if (!ok) {
      // ─── IL TENTATIVO CHE PIÙ DI OGNI ALTRO SI VUOLE POTER CONTARE ───────
      //
      // Fino al 2026-08-07 questo `return` era nudo, e il rifiuto non lasciava
      // NIENTE: `withRoute` classifica i 403 a livello `info`, e `vaPersistito`
      // manda in tabella solo `warn` ed `error`. Il collaudo ha provato dodici
      // volte di fila a scrivere sul registro di un bambino altrui — dodici 403
      // corretti — e in `app_log` non c'era una sola riga a dirlo. È la stessa
      // forma del difetto che ha aperto questo ciclo: una funzione vissuta un
      // mese in silenzio perfetto perché i suoi 403 erano `info`.
      //
      // ─── PERCHÉ QUI E NON NELLE ROUTE ────────────────────────────────────
      //
      // Perché il rifiuto lo decide QUESTA funzione, e le route che ci passano
      // sono venti: scriverlo in una coprirebbe una su venti, e le altre
      // diciannove resterebbero mute esattamente come oggi — è la stessa
      // divergenza che il ramo qui sotto ha già pagato (il `warn` c'era, ma solo
      // per metà dei rami). E il gemello per i NON-genitori sta 27 righe più
      // sotto, nello stesso file: una difesa sola, un posto solo.
      //
      // SOLO UUID ED ENUMERATI. `tipo`, `azione` e `ruolo` sono in lista bianca
      // di `redact`; `utente` e `alunno_id` passano per FORMA (uuid). Nessun
      // nome, nessuna email, nessun testo libero: sono dati di minori, e un
      // contatore di tentativi non ha bisogno di sapere di chi.
      logEvento('auth', 'warn', {
        tipo: 'alunno-non-della-famiglia',
        azione: 'requireParentOfStudent',
        utente: auth.user.id,
        ruolo: auth.user.role,
        alunno_id: studentId,
      })
      return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    }
    return { user: auth.user }
  }

  // ── Tutti gli altri ruoli: plesso + sezione assegnata ────────────────────
  // Prima di interrogare il DB: un id che non è un uuid non è un alunno. La
  // risposta onesta è 404 — la stessa che quasi tutte queste route danno già
  // quando il lookup su `alunni` non trova niente.
  if (!UUID.test(studentId ?? '')) {
    return { response: NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 }) }
  }

  const fuoriScope = await assertAlunnoInScope(supabase, auth.user, studentId)
  if (!fuoriScope) return { user: auth.user }

  // Il `warn` (persistito: `vaPersistito` manda in tabella warn ed error) va
  // SOLO sul 403. `assertAlunnoInScope` risponde anche 404 «alunno non trovato»
  // e 500 «verifica di scope non riuscita»: il primo è il banale id sbagliato, e
  // contarlo qui dentro renderebbe il segnale indistinguibile dal rumore — è la
  // stessa lezione già scritta in `assertParentInScope`. Il secondo si logga da
  // sé, a livello `error`.
  //
  // Un solo `tipo` per due dinieghi diversi (fuori plesso / fuori dalle proprie
  // sezioni): distinguerli qui vorrebbe dire leggere il corpo della risposta o
  // duplicare la logica dello scope. Restano distinguibili dal `ruolo`, che è
  // sulla riga: solo `educator` può essere negato per la sezione.
  if (fuoriScope.status === 403) {
    logEvento('auth', 'warn', {
      tipo: 'alunno-fuori-sede',
      azione: 'requireParentOfStudent',
      utente: auth.user.id,
      ruolo: auth.user.role,
    })
  }
  return { response: fuoriScope }
}
