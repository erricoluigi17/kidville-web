import { describe, it, expect } from 'vitest'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import type { SupabaseClient } from '@supabase/supabase-js'

// M5 — ri-firma vietata: una sola forms_submissions FIRMATA per (form_id, student_id).
// Difesa in profondità: pre-check applicativo + traduzione del vincolo DB (23505 → 409).

const TEMPLATE = { id: 'form-1', fields: [] }

type QueryResult = { data: unknown; error: unknown }

/**
 * Mock table-aware con code di risultati per tabella (FIFO). Le chiavi note:
 *  - forms_templates.single → template
 *  - forms_submissions.maybeSingle → pre-check firma esistente
 *  - forms_submissions.single (dopo insert().select()) → esito INSERT
 */
function makeClient(opts: {
  precheck?: QueryResult
  insert?: QueryResult
}): SupabaseClient {
  return {
    from(table: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'insert', 'update', 'eq', 'limit', 'in']) qb[m] = () => qb
      qb.single = () => {
        if (table === 'forms_templates') return Promise.resolve({ data: TEMPLATE, error: null })
        // forms_submissions insert().select().single()
        return Promise.resolve(opts.insert ?? { data: { id: 'sub-1' }, error: null })
      }
      qb.maybeSingle = () => {
        if (table === 'forms_submissions') return Promise.resolve(opts.precheck ?? { data: null, error: null })
        return Promise.resolve({ data: null, error: null })
      }
      return qb
    },
  } as unknown as SupabaseClient
}

const baseInput = {
  form_id: 'form-1',
  parent_id: 'parent-1',
  student_id: 'student-1',
  answers: {},
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
    expect(r.submission).toMatchObject({ id: 'sub-1' })
  })

  it('degrada pulito se is_signed column assente al pre-check (42703) → prosegue all’INSERT', async () => {
    const supabase = makeClient({ precheck: { data: null, error: { code: '42703' } } })
    const r = await persistSignedSubmission(supabase, baseInput)
    expect(r.status).toBe(201)
  })

  it('non applica il vincolo alle submission NON firmate (onboarding pending)', async () => {
    // is_signed=false → nessun pre-check, INSERT normale
    const supabase = makeClient({ precheck: { data: { id: 'x' }, error: null } })
    const r = await persistSignedSubmission(supabase, { ...baseInput, is_signed: false })
    expect(r.status).toBe(201)
  })
})
