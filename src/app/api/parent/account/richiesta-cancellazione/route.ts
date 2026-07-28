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

interface ParentBridge {
  id: string
  anonimizzato_il: string | null
}

/**
 * Ponte identità → riga `parents`, UNA VOLTA SOLA per tutti e tre gli handler.
 *
 * ⚠️ SPAZIO-ID, la ragione per cui questa funzione esiste: `auth.user.id` è l'id
 * della riga `utenti` (ruolo genitore); `parents.id` è un uuid indipendente
 * (`gen_random_uuid()`) e non coincide MAI con esso. Il ponte è
 * `parents.auth_user_id` — lo stesso di /api/me e di lib/pagamenti/intestatari.ts.
 *
 * `richieste_cancellazione.parent_id` è per contratto un **parents.id**: è così
 * che lo leggono /admin/gdpr e `anonimizzaParent`. Usare `auth.user.id` produceva
 * righe inevadibili (e, in lettura, non trovava mai la propria richiesta): l'oblio
 * self-service era morto in silenzio. Il ponte in un posto solo impedisce che i tre
 * handler tornino a divergere.
 *
 * PostgREST non lancia: si controlla `{ error }`. Uno schema assente (DB E2E della
 * CI non migrato: `42703` sulla colonna ponte) degrada a "nessun genitore"; un
 * errore inatteso viene propagato al chiamante, che logga e risponde 500.
 */
async function risolviParent(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  authUserId: string,
): Promise<{ parent: ParentBridge | null; errInatteso: unknown }> {
  const { data, error } = await admin
    .from('parents')
    .select('id, anonimizzato_il')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (error && !schemaAssente(error)) return { parent: null, errInatteso: error }
  return { parent: (data as ParentBridge | null) ?? null, errInatteso: null }
}

// GET — stato della richiesta corrente del genitore autenticato (o null).
export const GET = withRoute('parent/account/richiesta-cancellazione:GET', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  try {
    const admin = await createAdminClient()
    const { parent, errInatteso } = await risolviParent(admin, auth.user.id)
    if (errInatteso) {
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:GET', stato: 500 }, errInatteso)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    // Utente non (ancora) bridgeato a una riga `parents`: non può avere richieste.
    // Qui NON si risponde 403 come nel POST — questa è una probe di stato che la
    // pagina Profilo esegue a ogni apertura, non un'azione: "nessuna richiesta" è
    // la risposta corretta, e un errore farebbe lampeggiare un guasto inesistente.
    if (!parent) return NextResponse.json({ richiesta: null })

    const { data, error } = await admin
      .from('richieste_cancellazione')
      .select('id, stato, creata_il, evasa_il')
      .eq('parent_id', parent.id)
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
    // L'utente deve essere davvero un genitore: il ponte è `parents.auth_user_id`
    // (vedi `risolviParent` sopra per il perché, e lo stesso refuso corretto in
    // parent/onboarding e onboarding/consensi.ts).
    // NB: `parents` non ha `scuola_id` (la sede si ricava dall'identità utente).
    const { parent, errInatteso } = await risolviParent(admin, auth.user.id)
    if (errInatteso) {
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:POST', stato: 500 }, errInatteso)
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
    // `parent_id` = `parents.id` (NON `auth.user.id`): è lo spazio-id che
    // /admin/gdpr e `anonimizzaParent` si aspettano.
    const { data: ins, error: errIns } = await admin
      .from('richieste_cancellazione')
      .insert({ parent_id: parent.id, scuola_id: scuolaId, stato: 'pending' })
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
    const { parent, errInatteso } = await risolviParent(admin, auth.user.id)
    if (errInatteso) {
      logErrore({ operazione: 'parent/account/richiesta-cancellazione:DELETE', stato: 500 }, errInatteso)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    // Nessuna riga `parents` collegata → non c'è nulla da revocare. La revoca è
    // idempotente per natura (0 righe toccate): rispondere "0 revocate" è più
    // onesto di un 403 su un'operazione che comunque non avrebbe fatto niente.
    if (!parent) return NextResponse.json({ ok: true, revocate: 0 })

    const { data, error } = await admin
      .from('richieste_cancellazione')
      .update({ stato: 'revocata', aggiornata_il: new Date().toISOString() })
      .eq('parent_id', parent.id)
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
