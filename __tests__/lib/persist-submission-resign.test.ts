import { describe, it, expect } from 'vitest'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import type { SupabaseClient } from '@supabase/supabase-js'
import { signedFormsClient, FORM, PARENT, STUDENT, SUBMISSION, ORIGINAL_SIGNATURE } from '../fixtures/signed-forms'

// M5 — ri-firma vietata: una sola forms_submissions FIRMATA per (form_id, student_id).
// Difesa in profondità: pre-check applicativo + traduzione del vincolo DB (23505 → 409).


type QueryResult = { data: unknown; error: unknown }

/** Il finto applica filtri reali; il pre-check e il vincolo insert falliscono prima di mutare. */
function makeClient(opts: { precheck?: QueryResult; insert?: QueryResult }): SupabaseClient {
  const f = signedFormsClient()
  if (!opts.precheck?.data) f.db.forms_submissions = []
  if (opts.precheck?.error) f.faults['forms_submissions:select'] = opts.precheck.error
  if (opts.insert?.error) f.faults['forms_submissions:insert'] = opts.insert.error
  return f.client
}

const baseInput = {
  form_id: FORM,
  parent_id: PARENT,
  student_id: STUDENT,
  answers: { accept: true },
  signature_log: ORIGINAL_SIGNATURE,
  is_signed: true,
}

describe('persistSignedSubmission — ri-firma vietata (M5)', () => {
  it('409 se esiste già una firma per (form_id, student_id) — pre-check', async () => {
    const supabase = makeClient({ precheck: { data: { id: 'esistente' }, error: null } })
    const r = await persistSignedSubmission(supabase, baseInput)
    expect(r.status).toBe(409)
    expect(r.submission).toBeUndefined()
  })

  it('409 se l’INSERT viola l’indice unique (23505)', async () => {
    const supabase = makeClient({ insert: { data: null, error: { code: '23505', message: 'duplicate' } } })
    const r = await persistSignedSubmission(supabase, baseInput)
    expect(r.status).toBe(409)
  })

  it('201 quando non esiste ancora una firma', async () => {
    const supabase = makeClient({})
    const r = await persistSignedSubmission(supabase, baseInput)
    expect(r.status).toBe(201)
    expect(r.submission).toMatchObject({ id: SUBMISSION })
  })

  it('se il pre-check non può verificare le firme (42703) si ferma senza inserirne altre', async () => {
    const supabase = makeClient({ precheck: { data: null, error: { code: '42703' } } })
    const r = await persistSignedSubmission(supabase, baseInput)
    expect(r.status).toBe(500)
  })

  it('non applica il vincolo alle submission NON firmate (onboarding pending)', async () => {
    // is_signed=false → nessun pre-check, INSERT normale
    const supabase = makeClient({ precheck: { data: { id: 'x' }, error: null } })
    const r = await persistSignedSubmission(supabase, { ...baseInput, is_signed: false })
    expect(r.status).toBe(201)
  })
})
