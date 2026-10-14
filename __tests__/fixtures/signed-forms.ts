import type { SupabaseClient } from '@supabase/supabase-js'

export const FORM = '11111111-1111-4111-8111-111111111111'
export const PARENT = '22222222-2222-4222-8222-222222222222'
export const STUDENT = '33333333-3333-4333-8333-333333333333'
export const SCHOOL = '44444444-4444-4444-8444-444444444444'
export const SUBMISSION = '55555555-5555-4555-8555-555555555555'
export const ORIGINAL_SIGNATURE = {
  method: 'OTP_EMAIL', provider: 'Firma OTP via email (FES)',
  signed_at: '2026-08-05T09:00:00.000Z', timestamp: '2026-08-05T09:00:00.000Z',
  email: 'genitore@example.invalid', hash: 'hash-otp-originale', ip: '192.0.2.9',
  user_agent: 'user-agent-da-escludere', compliance: 'CAD Art. 20 / DPR 445/2000',
  parent_details: { nome: 'Genitore', cognome: 'Esempio' },
}
export function signedFormsDb() {
  return {
    forms_templates: [{ id: FORM, title: 'Autorizzazione uscita', description: 'Autorizzo la visita al museo.', scuola_id: SCHOOL, requires_signature: true, fields: [
      { id: 'accept', type: 'checkbox', label: 'Autorizzo la visita', required: true },
      { id: 'bus', type: 'checkbox', label: 'Utilizza autobus', required: false },
      { id: 'choice', type: 'select', label: 'Scelta', options: [{ value: 'yes', label: 'Prima opzione' }] },
      { id: 'note', type: 'textarea', label: 'Note', required: false },
    ] }],
    forms_submissions: [{ id: SUBMISSION, form_id: FORM, parent_id: PARENT, student_id: STUDENT, answers: { accept: true, bus: false, choice: 'yes', note: 'Risposta presente' }, is_signed: true, signature_log: structuredClone(ORIGINAL_SIGNATURE), pdf_path: null, created_at: '2026-08-06T08:00:00Z' }],
    alunni: [{ id: STUDENT, nome: 'Bambino', cognome: 'Esempio', scuola_id: SCHOOL }],
    utenti: [{ id: PARENT, nome: 'Genitore', cognome: 'Esempio', scuola_id: SCHOOL }],
  } as Record<string, Record<string, unknown>[]>
}

/** State-aware fake: JSONB CAS equality is exact and errors happen before mutation. */
export function signedFormsClient(db = signedFormsDb()) {
  const objects = new Map<string, Uint8Array>()
  const actions: Array<{ table: string; action: string; payload?: unknown; filters?: unknown }> = []
  const faults: Record<string, unknown> = {}
  const hooks: { beforeQuery?: (query: { table: string; action: string; payload?: unknown }) => Promise<void> } = {}
  const storage = {
    downloads: [] as string[], uploads: [] as Array<{ path: string; bytes: Uint8Array; options: unknown }>,
    async download(path: string) {
      this.downloads.push(path)
      if (faults.download) return { data: null, error: faults.download }
      const bytes = objects.get(path)
      return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { code: 'NoSuchKey', statusCode: '404', message: 'Object not found' } }
    },
    async remove(paths: string[]) {
      if (faults.remove) return { data: null, error: faults.remove }
      const removed = paths.filter((path) => objects.has(path) && !faults.keepFiles)
      removed.forEach((path) => objects.delete(path))
      return { data: removed.map((name) => ({ name })), error: null }
    },
    async list(folder: string, options: { search?: string } = {}) {
      if (faults.list) return { data: null, error: faults.list }
      const prefix = folder ? `${folder}/` : ''
      return { data: [...objects.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ name: p.slice(prefix.length) })).filter((r) => !options.search || r.name.startsWith(options.search)), error: null }
    },
    async upload(path: string, bytes: Uint8Array, options: unknown) {
      this.uploads.push({ path, bytes, options })
      if (faults.upload) return { data: null, error: faults.upload }
      if (objects.has(path)) return { data: null, error: { code: 'ResourceAlreadyExists', statusCode: '409', message: 'already exists' } }
      objects.set(path, bytes.slice())
      return { data: { path }, error: null }
    },
  }
  const client = {
    rpc: async () => ({ data: null, error: { code: 'PGRST202' } }),
    storage: { from: (bucket: string) => { if (bucket !== 'form_attachments') throw new Error('Wrong bucket'); return storage } },
    from(table: string) {
      let action = 'select'
      let payload: Record<string, unknown> | undefined
      const filters: Array<[string, unknown]> = []
      const inFilters: Array<[string, unknown[]]> = []
      const tests: Array<(row: Record<string, unknown>) => boolean> = []
      let maximum = Infinity
      let start = 0
      let sorted = false
      const readField = (row: Record<string, unknown>, key: string) => {
        if (!key.includes('->>')) return row[key]
        const [column, property] = key.split('->>')
        return (row[column] as Record<string, unknown> | undefined)?.[property]
      }
      const result = () => {
        actions.push({ table, action, payload, filters })
        if (faults[`${table}:${action}`]) return { data: null, error: faults[`${table}:${action}`] }
        const matches = (row: Record<string, unknown>) => filters.every(([key, value]) => JSON.stringify(readField(row, key) ?? null) === JSON.stringify(value)) && inFilters.every(([key, values]) => values.includes(readField(row, key)))
        let rows = (db[table] ?? []).filter((row) => matches(row) && tests.every((t) => t(row)))
        if (sorted) rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
        rows = rows.slice(start, start + maximum)
        if (action === 'insert') { const row = { id: SUBMISSION, ...structuredClone(payload) }; (db[table] ??= []).push(row); rows = [row] }
        if (action === 'update') rows.forEach((r) => Object.assign(r, structuredClone(payload)))
        if (action === 'delete') db[table] = (db[table] ?? []).filter((r) => !rows.includes(r))
        return { data: structuredClone(rows), error: null }
      }
      const execute = async () => { await hooks.beforeQuery?.({ table, action, payload }); return result() }
      const qb = {
        select: () => qb,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return qb },
        in: (key: string, values: unknown[]) => { inFilters.push([key, values]); return qb },
        is: (key: string, value: unknown) => { filters.push([key, value]); return qb },
        filter: (key: string, operator: string, value: string) => { if (operator !== 'eq') throw new Error('Unknown operator'); if (faults.maxFilterBytes && value.length > Number(faults.maxFilterBytes)) throw new Error('414 URI Too Long'); filters.push([key, JSON.parse(value)]); return qb },
        contains: (key: string, value: Record<string, unknown>) => { tests.push((r) => Object.entries(value).every(([k, v]) => JSON.stringify(r[key]).includes(JSON.stringify({ [k]: v }).slice(1, -1)))); return qb },
        or: () => qb,
        not: (key: string, operator: string, value: unknown) => { if (operator === 'is') tests.push((r) => (readField(r, key) ?? null) !== value); return qb },
        range: (from: number, to: number) => { start = from; maximum = to - from + 1; return qb },
        like: (key: string, value: string) => { tests.push((r) => String(readField(r, key) ?? '').startsWith(value.replaceAll('%', ''))); return qb },
        ilike: (key: string, value: string) => { tests.push((r) => String(readField(r, key) ?? '').toLowerCase().includes(value.replaceAll('%', '').toLowerCase())); return qb },
        neq: (key: string, value: unknown) => { tests.push((r) => readField(r, key) !== value); return qb },
        gt: (key: string, value: string) => { tests.push((r) => String(readField(r, key)) > value); return qb },
        order: () => { sorted = true; return qb },
        limit: (value: number) => { maximum = value; return qb },
        delete: () => { action = 'delete'; return qb },
        insert: (value: Record<string, unknown>) => { action = 'insert'; payload = value; return qb },
        update: (value: Record<string, unknown>) => { action = 'update'; payload = value; return qb },
        single: async () => { const r = await execute(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } },
        maybeSingle: async () => { const r = await execute(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } },
        then: (resolve: (v: unknown) => unknown) => execute().then(resolve),
      }
      return qb
    },
  } as unknown as SupabaseClient
  return { client, db, faults, objects, actions, storage, hooks }
}
