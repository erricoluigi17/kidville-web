import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { SCHEMA_MANCANTE } from '@/lib/protocolli/store'
import { rispostaErroreProtocollo } from '@/lib/protocolli/server'
import { TITOLARIO_DEFAULT } from '@/lib/scuole/corredo-sede'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Titolario configurabile (decisione #15): categorie per scuola con seed lazy
// dei default (le sedi nuove li ricevono alla prima apertura della pagina).
//
// Dal 2026-07-31 l'elenco NON vive più qui: è `TITOLARIO_DEFAULT`
// (src/lib/scuole/corredo-sede.ts), che è anche ciò che il provisioning di una
// sede nuova scrive — in SQL e nel ramo di fallback. Due copie della stessa
// lista divergono, e quale sede prende quale copia lo decide il caso. Il seed
// lazy resta: è la rete per le sedi create prima del corredo.
const CATEGORIE_DEFAULT = TITOLARIO_DEFAULT

const zScuolaPreferita = z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaPreferita })

const postBodySchema = z.object({
  scuola_id: zScuolaPreferita,
  nome: z.string({ error: 'Il nome della categoria è obbligatorio' }).trim().min(1).max(80),
  ordine: z.coerce.number().int().min(0).max(999).optional(),
})

const patchBodySchema = z.object({
  scuola_id: zScuolaPreferita,
  id: zUuid,
  nome: z.string().trim().min(1).max(80).optional(),
  ordine: z.coerce.number().int().min(0).max(999).optional(),
  attivo: z.boolean().optional(),
})

export const GET = withRoute('admin/protocolli/categorie:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId as string

      const leggi = () =>
        supabase
          .from('protocolli_categorie')
          .select('id, nome, ordine, attivo')
          .eq('scuola_id', scuolaId)
          .order('ordine', { ascending: true })
          .order('nome', { ascending: true })

      const { data, error } = await leggi()
      if (error) {
        if (SCHEMA_MANCANTE.has(error.code ?? '')) {
          return NextResponse.json({ success: true, data: [], nonMigrato: true })
        }
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      // Seed lazy per le sedi senza titolario (create dopo la migrazione).
      //
      // ⚠️ Fino al 2026-07-31 l'INSERT finiva in `.then(() => undefined, () => undefined)`,
      // che scarta ENTRAMBI gli esiti — e PostgREST non lancia: ritorna `{ error }`.
      // Seed fallito ⇒ la rilettura trovava ancora vuoto e la route rispondeva
      // `{ success: true, data: [] }`: quella sede avrebbe visto un titolario vuoto
      // per sempre, senza una riga in `app_log` che dicesse perché. È anche l'unico
      // auto-provisioning per sede del progetto, quindi il successo si logga:
      // «nessun log» non deve poter significare tanto «tutto ok» quanto «non è mai
      // partito niente» (AGENTS.md §5 e §6).
      if ((data ?? []).length === 0) {
        const { error: seedErr } = await supabase
          .from('protocolli_categorie')
          .insert(CATEGORIE_DEFAULT.map((nome, i) => ({ scuola_id: scuolaId, nome, ordine: i + 1 })))
        if (seedErr && seedErr.code !== '23505') {
          logEvento('protocolli', 'error', {
            operazione: 'admin/protocolli/categorie:GET',
            esito: 'seed-fallito',
            scuola_id: scuolaId,
            righe: CATEGORIE_DEFAULT.length,
          }, seedErr)
          return rispostaErroreProtocollo(seedErr)
        }
        if (seedErr) {
          // 23505: un'altra scheda (o un altro operatore) ha seminato per prima.
          // Non è un guasto — le categorie ci sono — ma va visto, perché è l'unico
          // modo di distinguerlo da un seed proprio.
          logEvento('protocolli', 'info', {
            operazione: 'admin/protocolli/categorie:GET',
            esito: 'seed-concorrente',
            scuola_id: scuolaId,
          })
        } else {
          logEvento('protocolli', 'info', {
            operazione: 'admin/protocolli/categorie:GET',
            esito: 'seed-eseguito',
            scuola_id: scuolaId,
            righe: CATEGORIE_DEFAULT.length,
          })
        }
        const riletto = await leggi()
        if (riletto.error) {
          logEvento('protocolli', 'error', {
            operazione: 'admin/protocolli/categorie:GET',
            esito: 'rilettura-titolario-fallita',
            scuola_id: scuolaId,
          }, riletto.error)
          return rispostaErroreProtocollo(riletto.error)
        }
        return NextResponse.json({ success: true, data: riletto.data ?? [] })
      }

      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/protocolli/categorie:GET', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})

export const POST = withRoute('admin/protocolli/categorie:POST', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuola_id)
      if (sw.response) return sw.response

      const { data, error } = await supabase
        .from('protocolli_categorie')
        .insert({ scuola_id: sw.scuolaId, nome: b.data.nome, ordine: b.data.ordine ?? 99 })
        .select()
        .single()
      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ error: 'Esiste già una categoria con questo nome' }, { status: 409 })
        }
        return rispostaErroreProtocollo(error)
      }
      return NextResponse.json({ success: true, data }, { status: 201 })
    } catch (err) {
      logErrore({ operazione: 'admin/protocolli/categorie:POST', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})

export const PATCH = withRoute('admin/protocolli/categorie:PATCH', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuola_id)
      if (sw.response) return sw.response

      const patch: Record<string, unknown> = {}
      if (b.data.nome !== undefined) patch.nome = b.data.nome
      if (b.data.ordine !== undefined) patch.ordine = b.data.ordine
      if (b.data.attivo !== undefined) patch.attivo = b.data.attivo
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('protocolli_categorie')
        .update(patch)
        .eq('id', b.data.id)
        .eq('scuola_id', sw.scuolaId as string)
        .select()
        .maybeSingle()
      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ error: 'Esiste già una categoria con questo nome' }, { status: 409 })
        }
        return rispostaErroreProtocollo(error)
      }
      if (!data) return NextResponse.json({ error: 'Categoria non trovata' }, { status: 404 })
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/protocolli/categorie:PATCH', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})
