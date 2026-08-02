import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// I TRE CONSENSI FOTOGRAFICI SI POSSONO REVOCARE — anche i due nuovi.
//
// IL DIFETTO (collaudo del 2026-08-01). `consenso_foto_sito` e
// `consenso_foto_social` nascono lo stesso giorno, con la migrazione che li
// raccoglie dalle domande d'iscrizione già approvate. Ma nessuna interfaccia e
// nessuna route sapeva scriverli: lo schema zod di `PATCH /api/admin/students`
// conosceva solo `consenso_privacy`, e `allowedFields` pure. L'unico modo di
// popolarli era importare una domanda.
//
// Conseguenza: una famiglia che cambia idea non poteva essere registrata da
// nessuna parte. Un consenso che non si può revocare non è un consenso —
// art. 7 §3 GDPR: «revocare il consenso dev'essere facile quanto prestarlo».
//
// Qui si verifica il ROUND-TRIP nei due versi su tutti e tre i canali, perché è
// la revoca (da `true` a `false`) la metà che mancava, e perché i tre canali
// sono DISTINTI: scriverne uno non deve toccare gli altri.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  updated: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
  assertAlunnoInScope: async () => null,
  assertAlunniInSezione: async () => null,
  assertSezioneInScope: async () => null,
  scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () => ({
        data: {
          id: 'al-1',
          scuola_id: 'sc-1',
          consenso_privacy: true,
          consenso_foto_sito: true,
          consenso_foto_social: true,
        },
        error: null,
      })
      b.update = (row: Record<string, unknown>) => {
        h.updated = row
        return b
      }
      b.single = async () => ({ data: { id: 'al-1', scuola_id: 'sc-1' }, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/students/route'

const ALUNNO = '22222222-2222-4222-8222-222222222222'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.updated = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('PATCH /api/admin/students — i consensi per canale si scrivono e si revocano', () => {
  it('REVOCA del consenso «sito web» → la colonna viene scritta a false', async () => {
    const res = await PATCH(req({ id: ALUNNO, consenso_foto_sito: false }) as never)
    expect(res.status).toBe(200)
    expect(h.updated?.consenso_foto_sito).toBe(false)
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('CONCESSIONE del consenso «sito web» → la colonna viene scritta a true', async () => {
    const res = await PATCH(req({ id: ALUNNO, consenso_foto_sito: true }) as never)
    expect(res.status).toBe(200)
    expect(h.updated?.consenso_foto_sito).toBe(true)
  })

  it('REVOCA del consenso «social» → la colonna viene scritta a false', async () => {
    const res = await PATCH(req({ id: ALUNNO, consenso_foto_social: false }) as never)
    expect(res.status).toBe(200)
    expect(h.updated?.consenso_foto_social).toBe(false)
  })

  it('i tre canali sono DISTINTI: revocare il sito non tocca galleria né social', async () => {
    const res = await PATCH(req({ id: ALUNNO, consenso_foto_sito: false }) as never)
    expect(res.status).toBe(200)
    // Controllo POSITIVO in negativo: gli altri due campi non devono comparire
    // affatto nell'update — non «essere true», proprio non esserci.
    expect(Object.keys(h.updated ?? {})).toContain('consenso_foto_sito')
    expect(Object.keys(h.updated ?? {})).not.toContain('consenso_privacy')
    expect(Object.keys(h.updated ?? {})).not.toContain('consenso_foto_social')
  })

  it('i tre consensi insieme, in un solo salvataggio (è come li manda il pannello)', async () => {
    const res = await PATCH(
      req({
        id: ALUNNO,
        consenso_privacy: false,
        consenso_foto_sito: false,
        consenso_foto_social: true,
      }) as never,
    )
    expect(res.status).toBe(200)
    expect(h.updated?.consenso_privacy).toBe(false)
    expect(h.updated?.consenso_foto_sito).toBe(false)
    expect(h.updated?.consenso_foto_social).toBe(true)
  })
})
