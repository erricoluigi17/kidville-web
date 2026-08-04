import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Ruoli di plesso avvisati oltre ai docenti della sezione (come panic-alert).
const STAFF_LOCKER = new Set(['segreteria', 'admin', 'coordinator'])

const postBodySchema = z.object({
  alunno_id: zUuid,
  materiale: z.string().trim().min(1).max(80),
})

// POST /api/locker/notify — "Avvisa" dell'armadietto genitore (M5.3): il
// genitore segnala scorte in esaurimento; destinatari = staff della scuola +
// docenti della sezione, via enqueueNotifiche tipo `locker_scorte`.
export const POST = withRoute('locker/notify:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const { user } = auth

  // Anti-spam: ogni chiamata genera una notifica per TUTTO lo staff del plesso.
  const rl = await rateLimit(`locker-notify:${clientIp(request)}`, { limit: 10, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppi avvisi inviati. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id: alunnoId, materiale } = b.data

  try {
    const supabase = await createAdminClient()

    // scope: il genitore deve essere collegato all'alunno — unione runtime
    // (`legame_genitori_alunni`) + anagrafica (`student_parents` via ponte
    // `parents.auth_user_id`).
    const collegato = await genitoreHasFiglio(supabase, user.id, alunnoId)
    if (!collegato) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, scuola_id, section_id')
      .eq('id', alunnoId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Destinatari: staff del plesso + docenti della sezione (utenti_sezioni;
    // section_id può essere null).
    //
    // L'APPARTENENZA A UNA SEDE NON È `utenti.scuola_id`: è l'unione fra quella
    // colonna e il ponte `utenti_scuole`. Qui c'era una `.eq('scuola_id', …)`
    // nuda, e per le sedi aperte il 2026-07-29 — dove nessuno ha ancora quel
    // plesso come primario — la lista usciva VUOTA. È la quarta occorrenza della
    // stessa forma (mensa/notify, panic-alert, fattura/sync), e l'unica che una
    // famiglia reale poteva già percorrere: `staffScuola` guarda il ponte ed è
    // l'unico posto del repo autorizzato a quella query.
    const destinatari = new Set<string>(
      await staffScuola(supabase, (alunno.scuola_id as string | null) ?? null, [...STAFF_LOCKER])
    )
    if (alunno.section_id) {
      for (const id of await docentiDiSezione(supabase, alunno.section_id)) destinatari.add(id)
    }

    if (destinatari.size === 0) {
      // La route risponde comunque 200 con `destinatari: 0` — e finché quel numero
      // non finiva anche in un log, «nessuno da avvisare» e «avvisati tutti» si
      // leggevano identici: il genitore vede una conferma e la richiesta non arriva
      // a nessuno. Nessun nome del bambino nella riga.
      logEvento('notifica', 'warn', {
        operazione: 'locker/notify:POST',
        esito: 'nessun-destinatario',
        sede_id: (alunno.scuola_id as string | null) ?? null,
        tipo: 'locker_scorte',
      })
    } else {
      await enqueueNotifiche(supabase, {
        utenteIds: [...destinatari],
        tipo: 'locker_scorte',
        titolo: `Armadietto: scorte basse di ${materiale}`,
        corpo: `Il genitore di ${alunno.nome} segnala scorte in esaurimento: ${materiale}.`,
        entitaTipo: 'armadietto',
        entitaId: alunnoId,
        bufferMin: 0,
        scuolaId: (alunno.scuola_id as string | undefined) ?? null,
      })
    }

    return NextResponse.json({ success: true, destinatari: destinatari.size })
  } catch (err) {
    logErrore({ operazione: 'locker/notify:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
