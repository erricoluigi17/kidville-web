import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Calendario } from '@/lib/anno-scolastico'
import { annoAttivoIdDi, caricaCalendario, STATI_RISERVATI, statoCalendario } from '@/lib/anno/calendario'
import { getFigliAttiviDiGenitore } from '@/lib/anagrafiche/legami'
import { eDirezione, eFamiglia, haRuolo, ruoliDi } from '@/lib/auth/predicati-ruolo'
import { requireUser } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { segnalaErroreLoggato } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'

// Nessun parametro ammesso: un `?x=1` è un 400 (la sede non si sceglie, si ricava dall'utente).
const getQuerySchema = z.object({}).strict()

// `Vary: Cookie`: dopo un cambio d'account sullo stesso browser la cache non serve per un minuto
// la risposta dell'utenza di prima.
const CACHE = { 'Cache-Control': 'private, max-age=60', Vary: 'Cookie' }
const SENZA_CACHE = { 'Cache-Control': 'no-store' }

const guasto = () =>
  NextResponse.json({ error: 'Calendario non disponibile', codice: 'LETTURA_FALLITA' }, { status: 500, headers: SENZA_CACHE })

/**
 * GET /api/anno/calendario — il calendario dell'anno scolastico delle sedi di chi chiede, perché il
 * browser calcoli «che anno è» con la stessa regola del server invece di `getMonth()` nel suo fuso.
 *
 * Sedi: lo staff le sue (`scuoleDiUtente`); il genitore quelle dei PROPRI figli attivi
 * (`getFigliAttiviDiGenitore`, lo stesso di `/api/parent/students`). Chi è entrambe le cose riceve
 * l'unione, e per ogni sede vale il ruolo più largo che ha lì. Direzione e segreteria vedono tutte le
 * righe; gli altri non vedono `in_preparazione` e `iscrizioni_aperte`.
 */
export const GET = withRoute('anno/calendario:GET', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const user = auth.user

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // sede -> vede anche gli anni in preparazione?
  const sedi = new Map<string, boolean>()

  if (ruoliDi(user).some((r) => r !== 'genitore')) {
    const completa = eDirezione(user) || haRuolo(user, 'segreteria')
    for (const s of await scuoleDiUtente(supabase, user)) sedi.set(s, completa)
  }

  if (eFamiglia(user)) {
    const esito = await getFigliAttiviDiGenitore(supabase, user.id)
    if (esito.errore) {
      logEvento('anno-scolastico', 'error', { tipo: 'calendario-figli-non-letti', operazione: 'anno/calendario:GET' })
      segnalaErroreLoggato()
      return guasto()
    }
    for (const f of esito.righe) {
      if (f.scuola_id && !sedi.has(f.scuola_id)) sedi.set(f.scuola_id, false)
    }
  }

  const data: Array<{ scuola_id: string; anno_attivo_id: string | null; righe: Calendario }> = []
  let nonDisponibili = 0
  for (const [scuolaId, completa] of sedi) {
    const stato = await statoCalendario(supabase, scuolaId)
    if (stato === 'guasto') {
      // Il guasto con la sede l'ha già scritto `caricaCalendario`: la marca evita che `withRoute`
      // aggiunga sul 5xx una seconda riga d'errore, più povera.
      segnalaErroreLoggato()
      return guasto()
    }
    if (stato === 'non_disponibile') {
      nonDisponibili++
      continue
    }
    const righe = (await caricaCalendario(supabase, scuolaId)) ?? []
    // L'anno attivo si ricava dalle righe INTERE, prima del filtro: il client lo usa come «anno di oggi»
    // quando l'anno che contiene il giorno è riservato e a lui non è arrivato (null = sede senza attivo).
    data.push({
      scuola_id: scuolaId,
      anno_attivo_id: annoAttivoIdDi(righe),
      righe: completa ? righe : righe.filter((r) => !STATI_RISERVATI.has(r.stato)),
    })
  }

  const fonte = sedi.size > 0 && nonDisponibili === sedi.size ? 'non_disponibile' : 'database'
  // Il successo lo scrive già `withRoute` (logOk): qui nessuna seconda riga.
  return NextResponse.json({ success: true, data, fonte }, { headers: CACHE })
})
