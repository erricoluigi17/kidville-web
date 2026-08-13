/**
 * `POST /api/admin/gdpr/richieste` — un oblio eseguito a metà non può risultare
 * concluso.
 *
 * IL FATTO (terzo collaudo, rilievo T15). Le due letture che stabiliscono QUALI
 * figli anonimizzare destrutturavano il solo `data`:
 *
 *   const { data: links } = await admin.from('student_parents')…
 *   const { data }        = await admin.from('alunni').in('id', childIds)
 *
 * PostgREST non lancia (AGENTS.md, regola 7). Con `links` a `[]` il flusso
 * proseguiva: `childIds=[]` → `figli=[]` → nessun `anonimizzaAlunno` →
 * `esito.alunni = 0` → richiesta marcata `evasa`. Il genitore veniva
 * anonimizzato, i BAMBINI no, e la richiesta si chiudeva: nessuno l'avrebbe mai
 * ripresa. La rotta sorella `admin/gdpr/erase` era già stata corretta nello
 * stesso ciclo, sulla stessa identica query; questa no.
 *
 * LA REGOLA: se non si sa QUALI figli toccare, non si tocca NIENTE — e in
 * particolare non si anonimizza il genitore, perché a quel punto l'oblio
 * resterebbe a metà comunque. 500 e una riga `error`; la richiesta resta
 * `pending`, cioè ripetibile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
import { NextRequest } from 'next/server'

const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'

const h = vi.hoisted(() => {
  const state = {
    richiesta: null as Record<string, unknown> | null,
    links: [] as { student_id: string }[],
    alunni: [] as Record<string, unknown>[],
    updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    /** Errore iniettato sulla lettura dei legami (`student_parents`). */
    errLinks: null as { code: string; message: string } | null,
    /** Errore iniettato sulla lettura dell'anagrafica dei figli (`alunni`). */
    errAlunni: null as { code: string; message: string } | null,
  }
  return {
    state,
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    anonimizzaParent: vi.fn(),
    anonimizzaAlunno: vi.fn(),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null
      const risposta = () => {
        if (table === 'student_parents') {
          return h.state.errLinks ? { data: null, error: h.state.errLinks } : { data: h.state.links, error: null }
        }
        if (table === 'alunni') {
          return h.state.errAlunni ? { data: null, error: h.state.errAlunni } : { data: h.state.alunni, error: null }
        }
        return { data: [], error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      // Le letture del dry-run che dicono CHE COSA distrugge (`contaCosaDistrugge`).
      b.contains = () => b
      b.not = () => b
      b.update = (v: Record<string, unknown>) => { patch = v; return b }
      b.maybeSingle = async () =>
        table === 'richieste_cancellazione'
          ? { data: h.state.richiesta, error: null }
          : { data: null, error: null }
      b.then = (res: (v: unknown) => unknown) => {
        if (patch) h.state.updates.push({ table, patch })
        return Promise.resolve(risposta()).then(res)
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/richieste/route'

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/gdpr/richieste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_A } })
  h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SEDE_A }
  h.state.links = []
  h.state.alunni = []
  h.state.updates = []
  h.state.errLinks = null
  h.state.errAlunni = null
  h.anonimizzaParent.mockResolvedValue({
    newsVisualizzazioniRimosse: 0, segnalazioniBonificate: 0, sospensioniBonificate: 0,
  })
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0,
    segnalazioniBonificate: 0, sospensioniBonificate: 0, presenzeBonificate: 0,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T15 — i legami non letti fermano l’oblio, non lo dichiarano fatto', () => {
  it('lettura di `student_parents` fallita → 500, e la richiesta NON si chiude', async () => {
    h.state.errLinks = { code: '42501', message: 'permission denied for table student_parents' }
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(500)
    expect(
      h.state.updates.find((u) => u.table === 'richieste_cancellazione'),
      'una richiesta marcata «evasa» non la ripete più nessuno',
    ).toBeFalsy()
  })

  it('lettura fallita → il GENITORE non viene anonimizzato (l’oblio resterebbe a metà)', async () => {
    h.state.errLinks = { code: '42501', message: 'permission denied' }
    await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
  })

  it('lettura fallita → resta una riga `error` con il codice PostgREST', async () => {
    h.state.errLinks = { code: '42501', message: 'permission denied' }
    await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(JSON.stringify(logErrore.mock.calls)).toContain('42501')
  })

  it('anche il `dryrun` non può mostrare «0 figli» quando la lettura è fallita', async () => {
    h.state.errLinks = { code: '42501', message: 'permission denied' }
    const res = await POST(req({ id: 'req-1', mode: 'dryrun' }))
    expect(res.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T15 — l’anagrafica dei figli non letta ferma allo stesso modo', () => {
  it('lettura di `alunni` fallita → 500, nessuna anonimizzazione, nessuna chiusura', async () => {
    h.state.links = [{ student_id: 'al-1' }]
    h.state.errAlunni = { code: '42501', message: 'permission denied for table alunni' }
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(500)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.state.updates.find((u) => u.table === 'richieste_cancellazione')).toBeFalsy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T15 — il percorso sano non cambia', () => {
  it('nessun errore: l’oblio procede e la richiesta si chiude', async () => {
    h.state.links = [{ student_id: 'al-1' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SEDE_A, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(200)
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect(h.state.updates.find((u) => u.table === 'richieste_cancellazione')).toBeTruthy()
  })
})
