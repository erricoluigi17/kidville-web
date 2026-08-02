import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody, parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { parseSidiZip } from '@/lib/sidi/zip-parser'
import { applySidiBatch } from '@/lib/sidi/import-apply'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso (userId è consumato dal gate)

// Il file si valida come presenza/istanza (contratto attuale: qualunque valore
// non-stringa passato in formData); il contenuto .zip non è materia di zod.
// `scuola_id` viaggia come CAMPO del multipart (qui il body è il form): è la sede
// in cui l'anagrafe ministeriale verrà riversata, e senza di essa l'admin
// multi-plesso importava alla cieca nella propria sede primaria.
type UploadedFile = { name?: string; arrayBuffer: () => Promise<ArrayBuffer> }
const postFormSchema = z.object({
  file: z.custom<UploadedFile>((v) => Boolean(v) && typeof v !== 'string', { error: 'File .zip mancante' }),
  scuola_id: zUuid.optional(),
})

const patchBodySchema = z.object({
  // `sidi_import_batches.id` è uuid NOT NULL: validarlo qui rende onesto il 400
  // sul valore malformato e permette al controllo di scope sotto di distinguere
  // «batch inesistente» da «lettura fallita» (prima qualunque stringa arrivava
  // fino alla query e il not-found copriva anche gli errori del DB).
  batchId: zUuid,
})

// GET /api/admin/sidi/import?userId=  — batch di import recenti.
export const GET = withRoute('admin/sidi/import:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    try {
      const supabase = await createAdminClient()
      // Scope di sede PRIMA di leggere: l'elenco porta il nome del file
      // ministeriale e i conteggi dell'anagrafe di un plesso. Scope vuoto ⇒
      // elenco vuoto (`.in()` con elenco vuoto non restituisce niente): mai
      // `if (plessi.length > 0)`, che è fail-open travestito da difesa.
      const plessi = await resolveScuoleAttive(request, supabase, auth.user)
      const { data, error } = await supabase
        .from('sidi_import_batches')
        .select('id, scuola_id, filename, stato, totale_record, matched, creati, created_at, applied_at')
        .in('scuola_id', plessi)
        .order('created_at', { ascending: false })
        .limit(20)
      if (error) {
        logErrore({ operazione: 'admin/sidi/import:GET', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true, data: data ?? [] })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/import:GET', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})

// POST /api/admin/sidi/import?userId=  — upload del .zip SIDI (NON rinominato),
// parse + staging (stato 'parsed'). Ritorna l'anteprima (totale + warnings).
export const POST = withRoute('admin/sidi/import:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    try {
      // Content-Type sbagliato = errore del CLIENT: 400, e non l'eccezione al `catch`
      // (`request.formData()` LANCIA). La regola vive in `parseMultipart`.
      const form = await parseMultipart(request)
      if ('response' in form) return form.response
      const f = parseData(postFormSchema, {
        file: form.data.get('file'),
        // FormData.get ritorna `null` quando il campo manca: zod vuole `undefined`.
        scuola_id: form.data.get('scuola_id') ?? undefined,
      })
      if ('response' in f) return f.response
      const { file } = f.data

      const buf = Buffer.from(await file.arrayBuffer())
      const parsed = await parseSidiZip(buf)
      const filename = file.name ?? 'sidi.zip'

      const supabase = await createAdminClient()
      // Import SIDI per singola scuola: la sede si DICHIARA (campo `scuola_id`
      // del form). Chi ha un solo plesso non se ne accorge; chi ne ha più d'uno
      // riceve 400 invece di veder comparire l'anagrafe nel plesso sbagliato.
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, f.data.scuola_id ?? undefined)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId

      const { data: batch, error } = await supabase
        .from('sidi_import_batches')
        .insert({
          scuola_id: scuolaId,
          filename,
          stato: 'parsed',
          totale_record: parsed.records.length,
          parsed_payload: parsed.records,
          warnings: parsed.warnings,
          caricato_da: auth.user.id,
        })
        .select('id')
        .single()
      if (error || !batch) {
        // Lo stato 500 lo vede `withRoute`, il MOTIVO no: senza questa riga
        // «lo ZIP non si carica» resta senza spiegazione nei log.
        logErrore({ operazione: 'admin/sidi/import:POST', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error?.message ?? 'Staging fallito' }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        batchId: batch.id,
        totale: parsed.records.length,
        warnings: parsed.warnings,
      })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/import:POST', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})

// PATCH /api/admin/sidi/import?userId=  — applica un batch alle anagrafiche.
// Riservato alla DIRIGENZA (mutazione anagrafica di massa). body: { batchId }
export const PATCH = withRoute('admin/sidi/import:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    try {
      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response

      const supabase = await createAdminClient()

      // ISOLAMENTO FRA SEDI (2026-07-31). `applySidiBatch` prendeva il batch per
      // solo id: il coordinatore di un plesso poteva riversare l'anagrafe
      // ministeriale di un ALTRO plesso — creando lì alunni e legami — perché il
      // gate `requireStaff(['admin','coordinator'])` verifica il ruolo, non il
      // tenant. La sede del batch è stata scelta al momento dell'upload: qui si
      // verifica soltanto che sia una delle proprie.
      // 404 (non 403) anche fuori scope: la risposta non deve dire se un batch
      // di un'altra sede esista.
      const plessi = await scuoleDiUtente(supabase, auth.user)
      const { data: batch, error: errBatch } = await supabase
        .from('sidi_import_batches')
        .select('id, scuola_id')
        .eq('id', b.data.batchId)
        .maybeSingle()
      if (errBatch) {
        logErrore({ operazione: 'admin/sidi/import:PATCH', stato: 500, evento: 'db' }, errBatch)
        return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
      }
      const sedeBatch = (batch?.scuola_id as string | null) ?? null
      if (!batch || !sedeBatch || !plessi.includes(sedeBatch)) {
        logEvento('sidi', 'warn', {
          tipo: 'batch-fuori-sede', operazione: 'admin/sidi/import:PATCH',
          esito: batch ? 'fuori-scope' : 'inesistente',
          utente: auth.user.id, ruolo: auth.user.role,
        })
        return NextResponse.json({ error: 'Batch non trovato' }, { status: 404 })
      }

      const res = await applySidiBatch(supabase, b.data.batchId, auth.user)
      if (res.error) return NextResponse.json({ error: res.error }, { status: res.status ?? 500 })
      logEvento('sidi', 'info', {
        tipo: 'import-applicato', operazione: 'admin/sidi/import:PATCH', esito: 'ok',
        utente: auth.user.id, matched: res.matched, creati: res.creati, aggiornati: res.aggiornati,
        avvisi: res.warnings.length,
      })
      return NextResponse.json({ success: true, ...res })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/import:PATCH', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})
