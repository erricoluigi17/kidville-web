import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppRole } from '@/lib/auth/require-staff'
import {
  assertSezioneInScope,
  assertUtenteInScope,
  resolveScuoleAttive,
  scuoleDiUtente,
} from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { RUOLI_VALIDI } from '@/lib/auth/ruoli'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const DIREZIONE = ['admin', 'coordinator'] as const
// Lettura estesa alla Segreteria (T3): l'elenco del personale è consultabile anche
// dalla Segreteria; le SCRITTURE (PATCH) restano riservate alla Direzione.
const LETTURA = [...DIREZIONE, 'segreteria'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// PATCH — body: { id, ruolo?, scuola_id?, gradi?, section_ids? }.
// gradi/section_ids non-array oggi vengono ignorati in silenzio (Array.isArray
// nel codice): restano z.unknown() per non respingere richieste che oggi passano.
const patchBodySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale 'id è obbligatorio')
  // Stessi valori ammessi di isRuoloAssegnabile (sostituisce il 400 manuale).
  ruolo: z.enum(RUOLI_VALIDI as [AppRole, ...AppRole[]], { error: 'Ruolo non assegnabile' }).optional(),
  scuola_id: zUuid.nullish(), // null oggi arriva al DB così com'è: preservato
  gradi: z.unknown().optional(),
  section_ids: z.unknown().optional(),
})

// GET /api/admin/staff — elenco personale (esclude i genitori). Lettura estesa
// alla Segreteria; le scritture (PATCH) restano riservate alla Direzione.
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Questo GET restituiva nome, cognome,
// email e sede di OGNI dipendente delle tre sedi, TUTTE le classi e TUTTE le
// assegnazioni. Non sono dati di minori, ma sono dati personali di lavoratori —
// e la mappa completa delle sezioni è l'inventario di uuid che serve per
// sfruttare gli altri difetti d'isolamento. Ora tutto è ristretto ai plessi
// attivi; le SEDI restano quelle accessibili perché alimentano la tendina di
// riassegnazione, che la PATCH valida comunque contro `scuoleDiUtente`.
export const GET = withRoute('admin/staff:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, [...LETTURA])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (plessi.length)`.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const accessibili = await scuoleDiUtente(supabase, auth.user)

    // contesto per la UI: personale + sedi + classi
    const [
      { data, error },
      { data: schools, error: errSchools },
      { data: sections, error: errSections },
    ] = await Promise.all([
      supabase
        .from('utenti')
        .select('id, nome, cognome, email, ruolo, scuola_id, gradi')
        .neq('ruolo', 'genitore')
        .in('scuola_id', plessi)
        .order('cognome', { ascending: true }),
      supabase.from('schools').select('id, nome').in('id', accessibili),
      supabase
        .from('sections')
        .select('id, name, scuola_id, school_type')
        .in('scuola_id', plessi)
        .order('name'),
    ])
    if (error) {
      logErrore({ operazione: 'admin/staff:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    // PostgREST non lancia: senza questi due controlli una lettura fallita
    // diventava una tendina vuota senza spiegazione (sedi/classi «sparite»).
    if (errSchools) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errSchools)
    if (errSections) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errSections)

    // Assegnazioni: solo quelle che legano un utente in scope a una classe in
    // scope. Filtrarle per uno solo dei due lati lascerebbe uscire l'altro.
    const idsUtenti = (data ?? []).map((u) => u.id as string)
    const idsSezioni = (sections ?? []).map((s) => s.id as string)
    const { data: asseg, error: errAsseg } = await supabase
      .from('utenti_sezioni')
      .select('utente_id, section_id')
      .in('utente_id', idsUtenti)
      .in('section_id', idsSezioni)
    if (errAsseg) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errAsseg)

    return NextResponse.json({
      success: true,
      data: data ?? [],
      schools: schools ?? [],
      sections: sections ?? [],
      assegnazioni: asseg ?? [],
    })
  } catch (err) {
    logErrore({ operazione: 'admin/staff:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/admin/staff — gestione RBAC (DL-028). Solo Direzione.
// Body: { id, ruolo?, scuola_id?, gradi?, section_ids? }
export const PATCH = withRoute('admin/staff:PATCH', async (request: Request) => {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response

    const parsed = await parseBody(request, patchBodySchema)
    if ('response' in parsed) return parsed.response
    const body = parsed.data
    const id = body.id

    // self-lockout guard: la Direzione non può cambiare il proprio ruolo
    if (body.ruolo !== undefined && id === auth.user.id) {
      return NextResponse.json({ error: 'Non puoi modificare il tuo stesso ruolo' }, { status: 403 })
    }

    const supabase = await createAdminClient()

    // Scope di sede sul BERSAGLIO. Fino al 2026-07-31 si validava soltanto la
    // sede di DESTINAZIONE (`body.scuola_id`): il gate era sul VALORE scritto e
    // non sul SOGGETTO scritto, quindi si cambiava ruolo, gradi e classi a un
    // dipendente di un altro plesso. 404 se non esiste, 403 se è di un'altra sede.
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, id)
    if (fuoriScope) return fuoriScope

    const patch: Record<string, unknown> = {}
    if (body.ruolo !== undefined) patch.ruolo = body.ruolo
    if (body.scuola_id !== undefined) {
      // MAI fidarsi dello scuola_id dal client: la sede destinazione deve
      // essere tra i plessi della Direzione. (null resta consentito e passa.)
      if (body.scuola_id !== null) {
        const plessi = await scuoleDiUtente(supabase, auth.user)
        if (!plessi.includes(body.scuola_id)) {
          return NextResponse.json({ error: 'Sede non consentita' }, { status: 403 })
        }
      }
      patch.scuola_id = body.scuola_id
    }
    if (Array.isArray(body.gradi)) patch.gradi = body.gradi

    // Le SEZIONI si validano PRIMA di qualunque scrittura. Il replace è
    // distruttivo (delete + insert): un 403 dopo il delete lascerebbe il
    // dipendente senza classi. E senza questo controllo si assegnavano a un
    // utente le sezioni di un'altra sede — che da lì in poi `sezioniDiUtente`
    // considera legittime, propagando il difetto a tutto il registro.
    const sezioni = Array.isArray(body.section_ids) ? (body.section_ids as unknown[]) : null
    if (sezioni) {
      for (const sid of sezioni) {
        const fuori = await assertSezioneInScope(supabase, auth.user, sid as string)
        if (fuori) return fuori
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('utenti').update(patch).eq('id', id)
      if (error) {
        logErrore({ operazione: 'admin/staff:PATCH', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    // assegnazione classi: replace completo
    if (sezioni) {
      // PostgREST non lancia: un delete fallito lasciava in piedi le
      // assegnazioni vecchie IN SILENZIO, e l'insert successivo ci si sommava.
      const { error: errDel } = await supabase.from('utenti_sezioni').delete().eq('utente_id', id)
      if (errDel) {
        logErrore({ operazione: 'admin/staff:PATCH', stato: 500, evento: 'db' }, errDel)
        return NextResponse.json({ error: errDel.message }, { status: 500 })
      }
      if (sezioni.length > 0) {
        const { error: errIns } = await supabase
          .from('utenti_sezioni')
          .insert(sezioni.map((sid) => ({ utente_id: id, section_id: sid as string })))
        if (errIns) {
          logErrore({ operazione: 'admin/staff:PATCH', stato: 500, evento: 'db' }, errIns)
          return NextResponse.json({ error: errIns.message }, { status: 500 })
        }
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'staff_rbac',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { ruolo: body.ruolo, scuola_id: body.scuola_id, section_ids: body.section_ids },
    })

    return NextResponse.json({ success: true, data: { id } })
  } catch (err) {
    logErrore({ operazione: 'admin/staff:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
