import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { EnrollmentSubmissionData } from '@/types/database.types'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` viene inserito INTERO nella colonna JSONB enrollment_submissions.data:
// .loose() preserva le chiavi extra del wizard. Gli elementi di children/adults
// restano liberi (oggi nessun vincolo sulla loro forma).
// `scuola_id` resta unknown: oggi QUALSIASI valore falsy (assente, '', null, …)
// ricade sul default, gestito nel codice con || come prima.
const postBodySchema = z.object({
  scuola_id: z.unknown().optional(),
  data: z
    .object(
      {
        children: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un bambino'),
        adults: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un adulto'),
      },
      { error: 'Dati iscrizione non validi' }
    )
    .loose(),
})

// POST: il genitore invia l'iscrizione dal form pubblico (service-role).
export const POST = withRoute('iscrizione:POST', async (request: NextRequest) => {
  try {
    // Rotta pubblica → rate-limit anti-abuso (5 invii / 10 min per IP).
    const rl = rateLimit(`iscrizione:${clientIp(request)}`, { limit: 5, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { data } = b.data

    const supabase = await createAdminClient()

    // Scuola dell'iscrizione: dal link (?scuola=) se indicata e valida; altrimenti
    // la scuola REALE del deployment. La scuola di test E2E (id e2e00000…) è
    // esclusa dalla risoluzione automatica, così in prod (E2E + reale) si sceglie
    // sempre quella reale. Con più scuole reali e nessuna indicata → 400.
    const { data: scuole } = await supabase.from('schools').select('id, nome')
    const tutte = (scuole ?? []) as { id: string; nome: string }[]
    const richiesta = (b.data.scuola_id as string | undefined) || undefined
    let scuolaId: string | undefined
    if (richiesta && tutte.some((s) => s.id === richiesta)) {
      scuolaId = richiesta
    } else {
      const isE2E = (s: { id: string; nome: string }) =>
        s.id.startsWith('e2e00000') || /e2e/i.test(s.nome)
      const reali = tutte.filter((s) => !isE2E(s))
      if (reali.length === 1) scuolaId = reali[0].id
      else if (tutte.length === 1) scuolaId = tutte[0].id
    }
    if (!scuolaId) {
      return NextResponse.json({ error: 'Specificare la scuola per l\'iscrizione' }, { status: 400 })
    }

    const { data: row, error } = await supabase
      .from('enrollment_submissions')
      .insert({
        scuola_id: scuolaId,
        data: data as EnrollmentSubmissionData,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Notifica alla segreteria: nuova domanda dal form pubblico (best-effort).
    try {
      const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
      await notificaEvento(supabase, {
        tipo: 'iscrizione_ricevuta',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Nuova domanda di iscrizione',
        corpo: 'È arrivata una nuova pre-iscrizione dal form pubblico.',
        link: '/admin/iscrizioni',
        entitaTipo: 'iscrizione',
        entitaId: row.id,
        bufferMin: 0,
      })
    } catch (e) {
      // `error` benché la domanda sia registrata (201): la segreteria non viene avvisata, e una
      // pre-iscrizione che nessuno sa di aver ricevuto è una famiglia che resta senza risposta.
      // La riga c'è, il suo annuncio è perso: scrittura persa, non dettaglio saltato.
      logEvento('notifica', 'error', {
        operazione: 'iscrizione:POST',
        esito: 'notifica-segreteria-non-accodata',
      }, e)
    }

    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'iscrizione:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
  }
})
