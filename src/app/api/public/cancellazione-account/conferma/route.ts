import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { verifyTicket, consumeTicket } from '@/lib/auth/otp-ticket'
import { risolviGenitorePerEmail } from '@/lib/gdpr/cancellazione-pubblica'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { risolviSedeRichiestaCancellazione } from '@/lib/gdpr/sede-richiesta'
import { parseBody } from '@/lib/validation/http'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Conferma della cancellazione account via magic-link (C5 §1).
//
// Reso raggiungibile SOLO da chi possiede il link firmato spedito all'email: il
// ticket HMAC lega email+code+expiry e non è forgiabile senza il segreto. Qui la
// verifica d'identità è dunque provata, e le risposte possono essere specifiche
// (a differenza del POST iniziale, che è generico per anti-enumerazione).
//
// VINCOLO DI SICUREZZA: questa route NON cancella nulla. Registra una richiesta
// `pending` (canale 'pubblico_email') che la Direzione evade da /admin/gdpr,
// esattamente come il percorso in-app.
// =============================================================================

const postBodySchema = z.object({
  email: z.string().email(),
  code: z.string().min(1),
  expiry: z.coerce.number().int().positive(),
  ticket: z.string().min(1),
})

export const POST = withRoute('public/cancellazione-account/conferma:POST', async (request: Request) => {
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { email, code, expiry, ticket } = b.data

  // 1) Verifica scadenza + firma HMAC. Nessun DB toccato se il ticket non regge.
  const v = verifyTicket(email, code, expiry, ticket)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const admin = await createAdminClient()

    // 2) Anti-replay: consuma il ticket (uso singolo). Un secondo click → 409.
    const c = await consumeTicket(admin, ticket, 'cancellazione_account_pubblica')
    if ('replay' in c) {
      return NextResponse.json({ error: 'Richiesta già confermata' }, { status: 409 })
    }

    // 3) Risolvi il genitore dall'email FIRMATA nel ticket.
    const { genitore, error } = await risolviGenitorePerEmail(admin, email)
    if (error) {
      logErrore({ operazione: 'public/cancellazione-account/conferma:POST', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!genitore) {
      return NextResponse.json({ error: 'Account non trovato o già cancellato' }, { status: 404 })
    }

    // SEDE DELLA RICHIESTA (W1). Qui c'era `genitore.scuolaId ?? scuolaUnicaReale(admin)`
    // e `scuolaUnicaReale` è DEPRECATA: con tre sedi reali risponde sempre `null`.
    // Una richiesta con `scuola_id NULL` non compare in nessun pannello di
    // Direzione (`.in('scuola_id', …)` scarta i NULL), non è evadibile e non è
    // ripresentabile (indice unico parziale su `pending`). Su QUESTO canale fa
    // ancora più danno che in-app: chi usa il magic-link spesso non ha più
    // l'applicazione, e non ha nessun modo di accorgersi che la sua richiesta non
    // è arrivata a nessuno. La sede viene dai FIGLI; se resta indeterminabile si
    // rifiuta con un messaggio leggibile.
    const sede = await risolviSedeRichiestaCancellazione(
      admin,
      genitore.parentId,
      genitore.scuolaId,
      'public/cancellazione-account/conferma:POST',
    )
    if (sede.scuolaId === null) {
      logEvento('gdpr', 'warn', {
        operazione: 'public/cancellazione-account/conferma:POST',
        esito: 'sede-non-determinabile',
        motivo: sede.motivo,
      })
      return NextResponse.json(
        {
          error:
            'Non è stato possibile stabilire la sede a cui inoltrare la richiesta. Contatta la segreteria della scuola: la cancellazione verrà registrata dal personale.',
        },
        { status: 422 },
      )
    }
    const scuolaId = sede.scuolaId

    // 4) Registra la richiesta pending. L'indice unico parziale (stato='pending')
    //    impedisce doppioni: 23505 → "hai già una richiesta in corso".
    const { data: ins, error: errIns } = await admin
      .from('richieste_cancellazione')
      .insert({ parent_id: genitore.parentId, scuola_id: scuolaId, stato: 'pending', canale: 'pubblico_email' })
      .select('id')
      .maybeSingle()
    if (errIns) {
      if ((errIns as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Hai già una richiesta di cancellazione in corso' }, { status: 409 })
      }
      if (schemaAssente(errIns)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'public/cancellazione-account/conferma:POST', stato: 500 }, errIns)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    // 5) Notifica la Direzione (best-effort, NESSUNA PII nel corpo). Riusa il tipo
    //    di notifica esistente 'richiesta_cancellazione_account'.
    try {
      const destinatari = await staffScuola(admin, scuolaId, ['admin', 'coordinator'])
      await notificaEvento(admin, {
        tipo: 'richiesta_cancellazione_account',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Richiesta di cancellazione account (via web)',
        corpo:
          'Un genitore ha richiesto la cancellazione del proprio account dalla pagina pubblica. Evadila dal pannello Privacy & Diritto all’Oblio.',
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
          operazione: 'public/cancellazione-account/conferma:POST',
          tipo: 'richiesta_cancellazione_account',
          esito: 'notifica_non_inviata',
        },
        e,
      )
    }

    // Evento critico: si logga anche il successo. Nessuna PII.
    logEvento('gdpr', 'info', {
      operazione: 'public/cancellazione-account/conferma:POST',
      esito: 'richiesta_creata',
      canale: 'pubblico_email',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    logErrore({ operazione: 'public/cancellazione-account/conferma:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
