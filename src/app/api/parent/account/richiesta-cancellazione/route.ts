import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Cancellazione account self-service del genitore (App Store 5.1.1(v) + GDPR).
// Modello A RICHIESTA: il genitore avvia la richiesta in-app (doppia conferma
// digitando ELIMINA), la Direzione la evade via anonimizzazione dal pannello
// Privacy & Diritto all'Oblio. Il genitore può REVOCARE finché è "pending".
// =============================================================================

const CONFERMA = 'ELIMINA'
const postBodySchema = z.object({ conferma: z.string().min(1) })

// GET — stato della richiesta corrente del genitore autenticato (o null).
export const GET = withRoute('parent/account/richiesta-cancellazione:GET', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  try {
    const admin = await createAdminClient()
    const { data, error } = await admin
      .from('richieste_cancellazione')
      .select('id, stato, creata_il, evasa_il')
      .eq('parent_id', auth.user.id)
      .order('creata_il', { ascending: false })
      .limit(1)
    if (error) {
      // DB E2E CI non migrato: nessuna richiesta possibile → degrada a "nessuna".
      if (schemaAssente(error)) return NextResponse.json({ richiesta: null })
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    return NextResponse.json({ richiesta: (data ?? [])[0] ?? null })
  } catch (err) {
    logErrore({ operazione: 'parent/account/richiesta-cancellazione:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

// POST — crea una richiesta "pending" (doppia conferma: conferma === 'ELIMINA').
export const POST = withRoute('parent/account/richiesta-cancellazione:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  if (String(b.data.conferma).trim().toUpperCase() !== CONFERMA) {
    return NextResponse.json({ error: `Conferma non valida: digita ${CONFERMA}` }, { status: 400 })
  }

  try {
    const admin = await createAdminClient()
    // L'utente deve essere davvero un genitore. `auth.user.id` è l'id della riga
    // `utenti` (ruolo genitore), NON `parents.id`: il ponte è `parents.auth_user_id`
    // (vedi lo stesso refuso corretto in parent/onboarding e onboarding/consensi.ts).
    // Con `.eq('id', auth.user.id)` questa query non trovava MAI la riga: ogni
    // richiesta di cancellazione in-app veniva rifiutata con 403, sempre.
    // NB: `parents` non ha `scuola_id` (la sede si ricava dall'identità utente).
    const { data: parent, error: errP } = await admin
      .from('parents')
      .select('id, anonimizzato_il')
      .eq('auth_user_id', auth.user.id)
      .maybeSingle()
    if (errP && !schemaAssente(errP)) {
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:POST', stato: 500 }, errP)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!parent) {
      return NextResponse.json(
        { error: 'Solo un genitore può richiedere la cancellazione del proprio account' },
        { status: 403 },
      )
    }
    if (parent.anonimizzato_il) {
      return NextResponse.json({ error: 'Account già cancellato' }, { status: 409 })
    }

    const scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(admin))

    // L'indice unico parziale (stato='pending') impedisce doppie richieste: 23505.
    const { data: ins, error: errIns } = await admin
      .from('richieste_cancellazione')
      .insert({ parent_id: auth.user.id, scuola_id: scuolaId, stato: 'pending' })
      .select('id')
      .maybeSingle()
    if (errIns) {
      if ((errIns as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Hai già una richiesta di cancellazione in corso' }, { status: 409 })
      }
      if (schemaAssente(errIns)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:POST', stato: 500 }, errIns)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    // Notifica alla Direzione (best-effort, NESSUNA PII nel corpo).
    try {
      const destinatari = await staffScuola(admin, scuolaId, ['admin', 'coordinator'])
      await notificaEvento(admin, {
        tipo: 'richiesta_cancellazione_account',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Richiesta di cancellazione account',
        corpo:
          'Un genitore ha richiesto la cancellazione del proprio account. Evadila dal pannello Privacy & Diritto all’Oblio.',
        link: '/admin/gdpr',
        entitaTipo: 'richiesta_cancellazione',
        entitaId: (ins?.id as string) ?? null,
        bufferMin: 0,
      })
    } catch (e) {
      logEvento(
        'notifica',
        'error',
        {
          operazione: 'parent/account/richiesta-cancellazione:POST',
          tipo: 'richiesta_cancellazione_account',
          esito: 'notifica_non_inviata',
        },
        e,
      )
    }

    // Successo loggato (evento critico): "richiesta creata" non è ambiguo col silenzio.
    logEvento('gdpr', 'info', {
      operazione: 'parent/account/richiesta-cancellazione:POST',
      esito: 'richiesta_creata',
    })
    return NextResponse.json({ ok: true, id: (ins?.id as string) ?? null })
  } catch (err) {
    logErrore({ operazione: 'parent/account/richiesta-cancellazione:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

// DELETE — revoca la richiesta pending del genitore (ripensamento).
export const DELETE = withRoute('parent/account/richiesta-cancellazione:DELETE', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  try {
    const admin = await createAdminClient()
    const { data, error } = await admin
      .from('richieste_cancellazione')
      .update({ stato: 'revocata', aggiornata_il: new Date().toISOString() })
      .eq('parent_id', auth.user.id)
      .eq('stato', 'pending')
      .select('id')
    if (error) {
      if (schemaAssente(error)) return NextResponse.json({ ok: true, revocate: 0 })
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:DELETE', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, revocate: (data ?? []).length })
  } catch (err) {
    logErrore({ operazione: 'parent/account/richiesta-cancellazione:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
