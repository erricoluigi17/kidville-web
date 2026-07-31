import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zPaginazione } from '@/lib/validation/common'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Coda di triage delle segnalazioni (Direzione). GET: elenco paginato con filtri
// opzionali stato/tipo_oggetto. PATCH: presa in carico / chiusura, con
// `gestita_il`/`gestita_da` scritti SEMPRE server-side (mai dal client).
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Fino a oggi la coda non filtrava per
// plesso: il gate `requireStaff(['admin','coordinator'])` verifica il RUOLO, e
// il coordinatore ha un solo plesso — eppure leggeva e chiudeva le segnalazioni
// delle altre due sedi. Il contenuto è UGC: `motivo` è testo libero scritto da
// un genitore su un contenuto che riguarda minori. Ora GET filtra per sede e
// PATCH rilegge la sede della singola segnalazione prima di scrivere.
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const

const getQuerySchema = z.object({
  stato: z.enum(['aperta', 'in_lavorazione', 'chiusa']).optional(),
  tipo_oggetto: z.enum(['messaggio_chat', 'media_galleria', 'voce_diario', 'utente']).optional(),
  ...zPaginazione.shape,
})

const patchBodySchema = z.object({
  id: zUuid,
  stato: z.enum(['in_lavorazione', 'chiusa']),
  note_gestione: z.string().max(2000).optional(),
})

export const GET = withRoute('admin/segnalazioni:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { stato, tipo_oggetto, limit, offset } = q.data

  try {
    const admin = await createAdminClient()
    // Scope di sede PRIMA di leggere. Scope vuoto ⇒ elenco vuoto: `.in()` con
    // elenco vuoto non restituisce niente, ed è la risposta giusta. Mai
    // `if (plessi.length > 0)`: quel ramo è fail-open travestito da difesa.
    const plessi = await resolveScuoleAttive(request, admin, auth.user)
    let query = admin
      .from('segnalazioni')
      .select('*', { count: 'exact' })
      .in('scuola_id', plessi)
      .order('creata_il', { ascending: false })
    if (stato) query = query.eq('stato', stato)
    if (tipo_oggetto) query = query.eq('tipo_oggetto', tipo_oggetto)
    query = query.range(offset, offset + limit - 1)

    const { data, count, error } = await query
    if (error) {
      // DB E2E CI non migrato (tabella assente): coda vuota, niente 500.
      if (schemaAssente(error)) return NextResponse.json({ segnalazioni: [], total: 0 })
      logErrore({ operazione: 'admin/segnalazioni:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    return NextResponse.json({ segnalazioni: data ?? [], total: count ?? 0 })
  } catch (err) {
    logErrore({ operazione: 'admin/segnalazioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

export const PATCH = withRoute('admin/segnalazioni:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  const { id, stato, note_gestione } = b.data

  try {
    const admin = await createAdminClient()

    // Scope di sede sul BERSAGLIO: si rilegge la sede della singola
    // segnalazione e la si confronta con i plessi dell'utente. Senza questo,
    // `.update(...).eq('id', id)` chiudeva la moderazione di un altro plesso —
    // e una moderazione già fatta non si può ri-attribuire.
    const { data: riga, error: errRiga } = await admin
      .from('segnalazioni')
      .select('id, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (errRiga) {
      if (schemaAssente(errRiga)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      // PostgREST non lancia: senza questo controllo un guasto di lettura
      // diventerebbe un 404 muto, indistinguibile da «non esiste».
      logErrore({ operazione: 'admin/segnalazioni:PATCH', stato: 500, evento: 'db' }, errRiga)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!riga) return NextResponse.json({ error: 'Segnalazione non trovata' }, { status: 404 })

    const plessi = await scuoleDiUtente(admin, auth.user)
    const sede = (riga.scuola_id as string | null) ?? null
    // Sede NULL ⇒ si nega: `segnalazioni.scuola_id` è nullable e con tre sedi
    // reali il ripiego `scuolaUnicaReale()` alla scrittura ritorna sempre null.
    // Una segnalazione senza plesso non è attribuibile a nessuno, quindi non è
    // moderabile da nessuno: meglio una riga in coda che nessuno chiude di una
    // moderata dalla sede sbagliata.
    if (!sede || !plessi.includes(sede)) {
      logEvento('segnalazione', 'warn', {
        operazione: 'admin/segnalazioni:PATCH',
        esito: 'segnalazione-fuori-sede',
        utente: auth.user.id,
        ruolo: auth.user.role,
        senza_sede: sede === null,
      })
      return NextResponse.json({ error: 'Segnalazione fuori dal tuo plesso' }, { status: 403 })
    }

    const update = {
      stato,
      note_gestione: note_gestione ?? null,
      // Autorship della gestione SEMPRE server-side: mai dal client.
      gestita_il: new Date().toISOString(),
      gestita_da: auth.user.id,
    }
    const { data, error } = await admin
      .from('segnalazioni')
      .update(update)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      if (schemaAssente(error)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'admin/segnalazioni:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Segnalazione non trovata' }, { status: 404 })

    logEvento('segnalazione', 'info', {
      operazione: 'admin/segnalazioni:PATCH',
      esito: 'segnalazione-gestita',
      stato,
    })
    return NextResponse.json({ ok: true, id: data.id })
  } catch (err) {
    logErrore({ operazione: 'admin/segnalazioni:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
