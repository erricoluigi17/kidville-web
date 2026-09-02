import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/locker/requests — IL GATE SEGUE IL GESTO
//
// M9 (2026-08) aveva chiuso un buco vero: la PATCH mutava lo stato di qualunque
// richiesta senza gate, e ci mise `requireDocente` + scope di sezione. La
// premessa scritta allora — «CAMBIO STATO = azione della scuola» — era però
// falsa per metà, e nessun test poteva accorgersene: `parent/locker/page.tsx`
// mostra al GENITORE il bottone «Preso in carico» e chiama proprio questa
// route, quindi ogni genitore che lo premeva prendeva 403. Il difetto NON era
// la tabella mancante: sarebbe rimasto anche dopo averla creata.
//
// Un gate solo per due gesti opposti:
//   presa_in_carico → è il GENITORE che dice «la porto»
//   evasa           → è la SCUOLA che dice «è arrivata»
//
// Da qui la doppia porta, e la prova che ciascuna resti chiusa all'altro. Le
// prove sul degrado restano perché la tolleranza resta: il DB E2E della CI è un
// progetto separato e non migrato.
// ─────────────────────────────────────────────────────────────────────────────

const idReq = '22222222-2222-2222-2222-222222222222'
const idAlunno = '11111111-1111-1111-1111-111111111111'

const h = vi.hoisted(() => {
  const rowResult = { current: { data: { id: 'r1', alunno_id: 'a1' }, error: null } as { data: unknown; error: unknown } }
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update', 'order', 'in']) qb[m] = () => qb
    qb.maybeSingle = () => Promise.resolve(rowResult.current)
    qb.single = () => Promise.resolve({ data: { id: 'r1', stato: 'presa_in_carico' }, error: null })
    return qb
  })
  return { requireParent: vi.fn(), requireDocente: vi.fn(), assertAlunnoInScope: vi.fn(), fromSpy, rowResult }
})

// I percorsi sono quelli VERI su disco (`src/lib/auth/require-parent.ts`,
// `require-staff.ts`, `scope.ts`): un `vi.mock` su un modulo che non esiste non
// aggancia niente e lascia il test verde sul vuoto.
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: vi.fn().mockResolvedValue(null),
  scuoleDiUtente: vi.fn().mockResolvedValue(['sc1']),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { PATCH } from '@/app/api/locker/requests/route'

function req(body: unknown) {
  return new Request('http://localhost/api/locker/requests', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParent.mockResolvedValue({ user: { id: 'p1', role: 'parent' } })
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc1' } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.rowResult.current = { data: { id: 'r1', alunno_id: idAlunno }, error: null }
})

describe('PATCH /api/locker/requests — il gate segue il gesto', () => {
  const confermaGenitore = { id: idReq, alunno_id: idAlunno, stato: 'presa_in_carico' }
  const evasioneScuola = { id: idReq, alunno_id: idAlunno, stato: 'evasa' }

  it('401 anonimo sulla conferma del genitore: nessuna mutazione', async () => {
    h.requireParent.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200: il genitore conferma «La porto» per il PROPRIO figlio', async () => {
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(200)
    expect(h.requireParent).toHaveBeenCalledWith(expect.anything(), idAlunno)
  })

  it('403: il genitore non conferma per il figlio di un altro', async () => {
    h.requireParent.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(403)
  })

  it('404: la riga non appartiene all alunno dichiarato nel corpo', async () => {
    // Il gate ha creduto al corpo: dopo, si verifica che la riga sia davvero sua.
    h.rowResult.current = { data: { id: 'r1', alunno_id: 'ALTRO' }, error: null }
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(404)
  })

  it('403: il genitore NON puo evadere — quello e un gesto della scuola', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(403)
    expect(h.requireParent).not.toHaveBeenCalled()
  })

  it('200: il docente evade dentro il proprio scope', async () => {
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(200)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(expect.anything(), expect.anything(), idAlunno)
  })

  it('403: il docente non evade fuori dal proprio scope', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(403)
  })

  it('tabella assente → degrada pulito', async () => {
    h.rowResult.current = { data: null, error: { code: '42P01', message: 'x' } }
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, degraded: true })
  })
})
