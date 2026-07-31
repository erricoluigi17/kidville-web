import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { publicFormUrl } from '@/lib/forms/publish'
import { colonnaSedeAssente } from '@/lib/forms/degrado-sede'
import { esitoScopeModello } from '@/lib/forms/scope-modello'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Pubblica / ritira un modello del Form Builder (DL-030). Gated alla Segreteria.
// publish: genera (o riusa) il public_token e imposta published_at → link /m/{token}.
// unpublish: azzera published_at (link disattivato) preservando il token.

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Sostituisce il 400 manuale 'id e action (publish|unpublish) sono obbligatori'.
// `id` resta stringa libera come il truthy check odierno (nei test circolano
// id non-UUID tipo 'm-1'). `access_mode` oggi non ha validazione runtime
// (solo cast TS): resta libero, il fallback (modello → 'public') resta nel codice.
const postBodySchema = z.object({
  id: z.string().min(1, 'id obbligatorio'),
  action: z.enum(['publish', 'unpublish'], {
    error: "action deve essere 'publish' o 'unpublish'",
  }),
  access_mode: z.unknown().optional(),
})

/** La riga del modello per i soli fini della pubblicazione. `scuola_id` è
 *  OPZIONALE perché sul DB E2E della CI, non migrato, la colonna non esiste: la
 *  chiave ASSENTE è il segnale su cui `esitoScopeModello` applica il degrado, ed
 *  è diversa da una chiave presente e vuota (modello globale). */
interface ModelloPubblicabile {
  id: string
  public_token: string | null
  published_at: string | null
  access_mode: string | null
  scuola_id?: string | null
}

export const POST = withRoute('admin/form-models/publish:POST', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { id, action, access_mode } = b.data

  try {
    const supabase = await createAdminClient()
    // `scuola_id` esiste dalla migrazione del 2026-07-30; sul DB E2E della CI,
    // che non è migrato, la SELECT fallirebbe con 42703 e il modello diventerebbe
    // «non trovato». Si rilegge senza la colonna: la riga arriva SENZA la chiave
    // e il gate applica il degrado (lecito solo con al più una sede reale).
    // NB: due `select()` distinti e non un ternario dentro `select()` — il client
    // Supabase tipizza quella stringa come LETTERALE e su un'unione produce un
    // `ParserError` invece del tipo della riga.
    const carica = async (conSede: boolean) => {
      const res = conSede
        ? await supabase.from('form_models')
            .select('id, public_token, published_at, access_mode, scuola_id').eq('id', id).maybeSingle()
        : await supabase.from('form_models')
            .select('id, public_token, published_at, access_mode').eq('id', id).maybeSingle()
      return { data: res.data as ModelloPubblicabile | null, error: res.error }
    }
    let caricato = await carica(true)
    if (colonnaSedeAssente(caricato.error)) caricato = await carica(false)
    const { data: model, error: loadErr } = caricato

    if (loadErr || !model) {
      return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 })
    }

    // Pubblicare, e soprattutto RITIRARE, è una scrittura sul modello di un
    // plesso: senza questo gate la segreteria di una sede poteva spegnere il
    // link pubblico d'iscrizione di un'altra (`action:'unpublish'` →
    // `published_at: null`, e `/m/{token}` smette di rispondere) o pubblicare un
    // modello che non doveva uscire. 404 se è di un'altra sede, 403 se è globale
    // e non si hanno tutte le sedi reali in scope.
    const negato = await esitoScopeModello(supabase, auth.user, model, {
      operazione: 'admin/form-models/publish:POST', perScrittura: true,
    })
    if (negato) return negato

    if (action === 'unpublish') {
      const { error } = await supabase
        .from('form_models')
        .update({ published_at: null })
        .eq('id', id)
        .select('id')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      // Successo loggato: un link pubblico ritirato è un modulo che smette di
      // rispondere alle famiglie, e va distinto da «non è mai stato ritirato».
      logEvento('modulistica', 'info', {
        operazione: 'admin/form-models/publish:POST', esito: 'modello-ritirato',
        utente: auth.user.id, ruolo: auth.user.role,
      })
      return NextResponse.json({ published: false })
    }

    // publish
    const token = (model.public_token as string | null) ?? randomUUID()
    const mode = access_mode ?? (model.access_mode as string | null) ?? 'public'
    const { error } = await supabase
      .from('form_models')
      .update({
        published_at: new Date().toISOString(),
        public_token: token,
        access_mode: mode,
      })
      .eq('id', id)
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Successo loggato: da qui in poi esiste un URL che apre un modulo senza
    // credenziali. Nessun token nel log — è la capability stessa.
    logEvento('modulistica', 'info', {
      operazione: 'admin/form-models/publish:POST', esito: 'modello-pubblicato',
      utente: auth.user.id, ruolo: auth.user.role,
    })

    return NextResponse.json({
      published: true,
      public_token: token,
      access_mode: mode,
      url: publicFormUrl(token),
    })
  } catch (err) {
    logErrore({ operazione: 'admin/form-models/publish:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
