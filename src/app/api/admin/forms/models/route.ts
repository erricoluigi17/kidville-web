import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

/** Campi esposti dall'ELENCO. `public_token` NON è fra questi, di proposito:
 *  è la capability che apre `/m/{token}` senza credenziali, e in una lista serve
 *  solo a farsi copiare altrove. Chi deve pubblicare o copiare il link passa da
 *  `admin/form-models/publish` (che lo restituisce) o dal costruttore, che
 *  carica il singolo modello — entrambi in scope di sede.
 *  La proiezione è ESPLICITA in codice e non affidata alla sola stringa di
 *  `select()`: così la garanzia è verificabile da un test. */
const CAMPI_ELENCO = [
  'id', 'title', 'description', 'is_active', 'is_enrollment_form',
  'published_at', 'access_mode', 'created_at',
] as const

// GET /api/admin/forms/models — elenco modelli (id, title) per i filtri admin.
// Gated (Segreteria+Direzione); sostituisce la lettura anon di `form_models`.
export const GET = withRoute('admin/forms/models:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()

    // Isolamento per sede. `scuola_id` NULL = modello GLOBALE: vale per tutte le
    // sedi, quindi si legge da tutte — ed è per questo che serve `.or()` e non
    // un `.in()` secco, che in SQL scarterebbe i NULL (`NULL IN (…)` vale NULL).
    // Scope vuoto ⇒ restano i soli globali: nessun modello di plesso esce.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const filtroSede = plessi.length > 0
      ? `scuola_id.is.null,scuola_id.in.(${plessi.join(',')})`
      : 'scuola_id.is.null'

    // Due `select()` distinti e non una stringa costruita: il client Supabase
    // tipizza la stringa di `select()` come LETTERALE, e su un valore calcolato
    // risponde con un `ParserError` al posto del tipo delle righe.
    const leggi = async (conSede: boolean) => {
      const res = conSede
        ? await supabase.from('form_models')
            .select('id, title, description, is_active, is_enrollment_form, published_at, access_mode, created_at, scuola_id')
            .or(filtroSede).order('title')
        : await supabase.from('form_models')
            .select('id, title, description, is_active, is_enrollment_form, published_at, access_mode, created_at')
            .order('title')
      return { data: (res.data ?? []) as unknown as Record<string, unknown>[], error: res.error }
    }
    let res = await leggi(true)
    if (colonnaSedeAssente(res.error)) {
      // DB E2E della CI non migrato: si prosegue senza filtro solo se non c'è
      // niente da isolare (al più una sede reale). Altrimenti si nega.
      if (!(await degradoSedeLecito(supabase, 'admin/forms/models:GET'))) {
        return NextResponse.json({ error: 'Isolamento per sede non disponibile' }, { status: 500 })
      }
      res = await leggi(false)
    }
    if (res.error) {
      logEvento('modulistica', 'error', {
        operazione: 'admin/forms/models:GET', esito: 'modelli-non-letti',
      }, res.error)
      return NextResponse.json({ error: res.error.message }, { status: 500 })
    }

    const elenco = res.data.map((r) => Object.fromEntries(CAMPI_ELENCO.map((c) => [c, r[c]])))
    return NextResponse.json(elenco)
})
