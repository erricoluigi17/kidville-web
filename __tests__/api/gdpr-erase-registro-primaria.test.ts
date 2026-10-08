import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TABELLE_REGISTRO_PRIMARIA } from '@/lib/alunni/registro-primaria'

// ─────────────────────────────────────────────────────────────────────────────
// IL REGISTRO DELLA PRIMARIA NON SI ANONIMIZZA (titolare, 2026-10-08).
//
// Voti, pagelle, scrutini, note e certificati delle competenze sono il registro
// che la legge obbliga a conservare: è l'eccezione dell'art. 17 §3 lett. b del
// GDPR. La route dell'oblio deve rifiutare in `dryrun` E in `execute`, PRIMA di
// qualunque scrittura; e una lettura del registro fallita la ferma con un 500 —
// «non ho potuto guardare» non può aprire un'anonimizzazione irreversibile.
//
// Stampo: `gdpr-erase-route.test.ts`. Qui il db finto è indicizzato per tabella
// (`h.db`), così ogni tabella del registro si accende da sola.
// ─────────────────────────────────────────────────────────────────────────────

const AL = 'a1b2c3d4-0000-4000-8000-00000000a001'
const SC = 'a1b2c3d4-0000-4000-8000-00000000c001'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  anonimizzaParent: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  // Le righe di ogni tabella, per nome. Una tabella assente qui risponde `[]`.
  db: {} as Record<string, Record<string, unknown>[]>,
  // Errore PostgREST iniettato per tabella (PostgREST non lancia: torna nel valore).
  errori: {} as Record<string, { code: string; message: string }>,
  // Ogni scrittura, con la sua tabella: UPDATE, DELETE, file tolti, RPC.
  scritture: [] as { tipo: string; tabella?: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
// `logEvento` è spiato, non silenziato: il rifiuto è un evento che deve restare
// visibile, e senza un'asserzione «loggato» è indistinguibile da «mai tentato».
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
// Le funzioni dell'oblio restano VERE: sono solo spiate, per poter dire «non è
// partita» senza fidarsi di un finto che non fa niente.
vi.mock('@/lib/gdpr/esegui', async (originale) => {
  const vero = await originale<typeof import('@/lib/gdpr/esegui')>()
  h.anonimizzaAlunno.mockImplementation(vero.anonimizzaAlunno)
  h.anonimizzaParent.mockImplementation(vero.anonimizzaParent)
  return { ...vero, anonimizzaAlunno: h.anonimizzaAlunno, anonimizzaParent: h.anonimizzaParent }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'neq', 'in', 'or', 'like', 'order', 'range', 'ilike', 'contains', 'not', 'limit']) {
        b[m] = () => b
      }
      b.delete = () => { h.scritture.push({ tipo: 'delete', tabella: table }); return b }
      b.update = () => { h.scritture.push({ tipo: 'update', tabella: table }); return b }
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? h.alunno : (h.db[table]?.[0] ?? null),
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        if (h.errori[table]) return Promise.resolve({ data: null, error: h.errori[table] }).then(res)
        return Promise.resolve({ data: h.db[table] ?? [], error: null }).then(res)
      }
      return b
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => { h.scritture.push({ tipo: 'storage-remove', tabella: paths.join(',') }); return { error: null } },
        list: async () => ({ data: [] as { name: string }[], error: null }),
      }),
    },
    rpc: async (nome: string) => {
      h.scritture.push({ tipo: 'rpc', tabella: nome })
      return { data: { ok: true, intenti: 0, revocati: 0 }, error: null }
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SC } })
  h.alunno = {
    id: AL, nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', anonimizzato_il: null,
    documento_path: null, codice_fiscale: null, fiscal_code: null, scuola_id: SC, section_id: null,
  }
  h.db = {}
  h.errori = {}
  h.scritture = []
})

describe('oblio GDPR — il registro della primaria si conserva', () => {
  it('dryrun su un bambino con un voto: 409 REGISTRO_PRIMARIA_DA_CONSERVARE, nessuna scrittura', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.scritture).toEqual([])
  })

  it.each(TABELLE_REGISTRO_PRIMARIA)('basta UNA riga in `%s` per rifiutare', async (tabella) => {
    h.db[tabella] = [{ id: 'r-1', alunno_id: AL }]
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
  })

  it('execute con conferma giusta: rifiuta lo stesso, e anonimizzaAlunno non parte', async () => {
    h.db.pagelle = [{ id: 'pg-1', alunno_id: AL, file_url: 'x.pdf' }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DIPROVA BAMBINO' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.scritture.filter((s) => s.tabella === 'alunni')).toEqual([])
    // Nessuna scrittura di nessun tipo: né UPDATE, né DELETE, né file, né RPC.
    expect(h.scritture).toEqual([])
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('una lettura del registro FALLITA ferma l’oblio con 500', async () => {
    h.errori = { note_disciplinari: { code: '57014', message: 'timeout' } }
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('GDPR_ERASE_NON_RIUSCITO')
  })

  it('una lettura FALLITA ferma anche l’execute, prima di ogni scrittura', async () => {
    h.errori = { scrutinio_giudizi: { code: '42501', message: 'permission denied' } }
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DIPROVA BAMBINO' }))
    expect(res.status).toBe(500)
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.scritture).toEqual([])
  })

  it('il rifiuto lascia un log', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr',
      'warn',
      expect.objectContaining({ esito: 'oblio-rifiutato-registro-primaria', entita_id: AL }),
    )
    // Nessun nome: `gdpr` è un evento PERSISTITO.
    const riga = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'oblio-rifiutato-registro-primaria')
    expect(JSON.stringify(riga)).not.toMatch(/Bambino|DiProva/)
  })

  // ── Il controllo: senza registro l'oblio procede come sempre ──────────────
  // Senza questi due casi i rifiuti qui sopra potrebbero essere verdi per un
  // finto che rifiuta tutto.
  it('senza registro il dryrun resta 200', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(200)
    expect((await res.json()).dryrun).toBe(true)
  })

  it('senza registro l’execute anonimizza', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DIPROVA BAMBINO' }))
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect(h.scritture.some((s) => s.tipo === 'update' && s.tabella === 'alunni')).toBe(true)
  })
})
