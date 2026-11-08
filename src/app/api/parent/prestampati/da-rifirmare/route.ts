import { NextResponse } from 'next/server'
import { z } from 'zod'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { soloFamiglia } from '@/app/api/parent/prestampati/banco-famiglia'
import { getFigliAttiviDiGenitore } from '@/lib/anagrafiche/legami'
import { caricaCalendario, statoCalendario } from '@/lib/anno/calendario'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
// Dal MODULO PURO, non da `require-staff`: i test sostituiscono quest'ultimo con una factory (vedi `parent/prestampati`).
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { requireUser } from '@/lib/auth/require-staff'
import { segnalaErroreLoggato } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import {
  confineRifirma,
  moduliDaRifirmare,
  type FirmaArchiviata,
  type ModuloDaRifirmare,
} from '@/lib/prestampati/da-rifirmare'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'

const OPERAZIONE = 'parent/prestampati/da-rifirmare:GET'

// Nessun parametro in ingresso: `userId` in query è consumato dal gate identità (`requireUser`).
const getQuerySchema = z.object({})

const guasto = () =>
  NextResponse.json({ error: 'Moduli da rifirmare non disponibili', codice: 'LETTURA_FALLITA' }, { status: 500 })

/**
 * GET /api/parent/prestampati/da-rifirmare — i moduli che i figli attivi di chi chiede devono rifirmare.
 *
 * Il calcolo e le sue ragioni stanno in `@/lib/prestampati/da-rifirmare`; qui stanno le letture. Il fascicolo si
 * apre solo per chi ha frequentato un anno prima dell'attivo: oggi nessuno, quindi oggi questa route non lo
 * legge affatto. Non ha ancora una schermata: finché non c'è un secondo anno attivo non avrebbe niente da
 * mostrare, e l'elenco della segreteria è della PR 4.5.
 *
 * Schema dell'anno assente (il DB della CI): lista vuota con un log `info`. Ogni altro errore è un 500, perché
 * «non l'ho potuto leggere» non diventa «non c'è niente da rifirmare».
 */
export const GET = withRoute('parent/prestampati/da-rifirmare:GET', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  // PRESENTAZIONE, come nelle altre rotte della famiglia: a una docente-genitore in veste di lavoro si risponde
  // che questi moduli sono del banco della famiglia, e per i propri figli commuta la veste.
  if (!agisceComeGenitore(auth.user)) return soloFamiglia()
  const utente = auth.user.id

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const risposta = (data: { alunno_id: string; moduli: ModuloDaRifirmare[] }[]) => {
    // Con i soli errori, «nessun log» non distinguerebbe «non c'è niente da rifirmare» da «non è mai partito».
    const n = data.reduce((somma, d) => somma + d.moduli.length, 0)
    logEvento('modulistica', 'info', { operazione: OPERAZIONE, esito: 'da-rifirmare-calcolato', utente, n })
    return NextResponse.json({ success: true, data })
  }

  const supabase = await createAdminClient()

  const figli = await getFigliAttiviDiGenitore(supabase, utente)
  // `completo: false` = l'elenco può essere corto, e potrebbe mancare proprio il figlio da rifirmare.
  // Il guasto lo ha già registrato `getFigliAttiviDiGenitore`: qui non si raddoppia.
  if (figli.errore || !figli.completo) {
    segnalaErroreLoggato()
    return guasto()
  }
  if (figli.righe.length === 0) return risposta([])

  // PostgREST non lancia: il valore di ritorno va controllato, sempre.
  const { data: frequenze, error: erroreFrequenze } = await supabase
    .from('frequenze')
    .select('alunno_id, anno_id')
    .in(
      'alunno_id',
      figli.righe.map((f) => f.id),
    )
  if (erroreFrequenze) {
    if (schemaAnnoIndietro(erroreFrequenze)) {
      logEvento('anno-scolastico', 'info', { tipo: 'frequenze-non-disponibili', operazione: OPERAZIONE })
      return risposta([])
    }
    logEvento(
      'modulistica',
      'error',
      { operazione: OPERAZIONE, esito: 'frequenze-non-lette', error_code: erroreFrequenze.code ?? null },
      erroreFrequenze,
    )
    segnalaErroreLoggato()
    return guasto()
  }

  const anniDi = new Map<string, Set<string>>()
  for (const f of (frequenze ?? []) as { alunno_id: string; anno_id: string }[]) {
    anniDi.set(f.alunno_id, (anniDi.get(f.alunno_id) ?? new Set<string>()).add(f.anno_id))
  }

  // Il calendario è quello della sede di oggi: la frequenza dell'altra sede di un trasferito conta lo stesso,
  // perché `anno_id` è dell'anno e non della sede.
  const confini = new Map<string, string>()
  for (const f of figli.righe) {
    if (!f.scuola_id) continue
    const stato = await statoCalendario(supabase, f.scuola_id)
    if (stato === 'guasto') {
      // Il guasto con la sede l'ha già scritto `caricaCalendario`.
      segnalaErroreLoggato()
      return guasto()
    }
    if (stato === 'non_disponibile') continue
    const calendario = await caricaCalendario(supabase, f.scuola_id)
    const confine = confineRifirma(calendario, anniDi.get(f.id) ?? new Set<string>())
    if (confine) confini.set(f.id, confine)
  }
  if (confini.size === 0) return risposta([])

  // Il fascicolo di un minore si apre dalla stessa porta di ogni altra rotta della famiglia, anche se questi figli
  // vengono dai legami di chi chiede: è quella porta a contare un tentativo vero e a dire che il legame c'è ancora.
  const candidati = [...confini.keys()]
  for (const alunnoId of candidati) {
    const portata = await requireParentOfStudent(request, alunnoId)
    if (portata.response) return portata.response
  }

  // Niente `document_type` dentro la query: sul DB della CI uno slug fuori dall'enumerazione risponde `22P02`
  // (vedi `parent/prestampati`). Il filtro sui moduli sta in `moduliDaRifirmare`.
  const { data: documenti, error: erroreFascicolo } = await fascicoloVivo(
    supabase.from('student_documents').select('student_id, document_type, created_at').in('student_id', candidati),
  )
  if (erroreFascicolo) {
    logEvento(
      'modulistica',
      'error',
      { operazione: OPERAZIONE, esito: 'fascicolo-non-letto', error_code: erroreFascicolo.code ?? null },
      erroreFascicolo,
    )
    segnalaErroreLoggato()
    return guasto()
  }

  // Regola 5 di `docs/prestampati/README.md`: ogni lettura del fascicolo passa dal registro degli accessi.
  for (const alunnoId of candidati) {
    await logAccessoFascicolo(supabase, {
      alunnoId,
      utenteId: utente,
      azione: 'list',
      finalita: 'Moduli da rifirmare (famiglia)',
      request,
    })
  }

  const firmeDi = new Map<string, FirmaArchiviata[]>()
  for (const d of (documenti ?? []) as unknown as (FirmaArchiviata & { student_id: string })[]) {
    firmeDi.set(d.student_id, [...(firmeDi.get(d.student_id) ?? []), d])
  }

  return risposta(
    [...confini].flatMap(([alunno_id, confine]) => {
      const moduli = moduliDaRifirmare(firmeDi.get(alunno_id) ?? [], confine)
      return moduli.length > 0 ? [{ alunno_id, moduli }] : []
    }),
  )
})
