/**
 * `POST`/`PATCH /api/gallery`: i bambini che tagghi devono essere dei tuoi plessi.
 *
 * IL DIFETTO (collaudo privacy del 2026-07-31, rilievo F3 — grave).
 * `alunniSenzaConsenso()` interrogava `alunni` con `.in('id', ids)` **senza alcun
 * filtro di sede**, e veniva chiamata **prima** che la sede di scrittura fosse
 * risolta. Quando due o più minori sono taggati e almeno uno è privo di
 * liberatoria, la route risponde 422 con `nomi: [...]` e `ids: [...]`: nome e
 * cognome completi, più l'informazione — di per sé sensibile — che a quel minore
 * *manca la liberatoria fotografica*.
 *
 * Misurato dal tester, con controprova su tre sedi:
 *   segreteria AVERSA → POST con due uuid di minori di GIUGLIANO
 *     ⇒ 422 con i loro 2 nomi veri, coincidenti con l'anagrafica
 *   segreteria CESA → stesso 422, stessi nomi
 *   segreteria GIUGLIANO (che ne ha titolo) → risposta IDENTICA
 * Cioè: sul tagging non esisteva alcun gate di sede. Basta conoscere gli uuid, e
 * un uuid non è un segreto — una segreteria che cambia plesso se li porta dietro.
 *
 * CAUSA RADICE. Il Privacy Lock (DL-041) è nato mono-sede, quando «un uuid di
 * alunno» implicava «un alunno mio». L'audit del 31/07 ha messo lo scope su GET,
 * PATCH e DELETE di questa stessa route, ma `tag_students` è rimasto l'unico
 * ingresso che accetta identificatori di minori senza chiedersi di chi siano.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31): togliendo il controllo di scope, il
 * primo caso torna 422 con i nomi — cioè il test diventa rosso sull'asserzione che
 * conta, quella sul corpo, non solo sullo status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const AVERSA = '22222222-2222-4222-8222-222222222222'
const MINORE_ALTRA_SEDE_1 = '44444444-4444-4444-8444-444444444444'
const MINORE_ALTRA_SEDE_2 = '55555555-5555-4555-8555-555555555555'
const MINORE_MIO = '66666666-6666-4666-8666-666666666666'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  alunniSenzaConsenso: vi.fn(),
  /** id → sede, come sta in `alunni`. */
  sediAlunni: new Map<string, string>(),
  scritture: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireStaff,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  assertAlunnoInScope: vi.fn(async () => null),
  sezioniVisibili: vi.fn(async () => null),
}))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: h.alunniSenzaConsenso }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'is', 'neq', 'or', 'range', 'gte', 'lte']) qb[m] = () => qb
      // `.in()` va ACCUMULATO, non sovrascritto: la query vera è
      // `.in('id', tag).in('scuola_id', plessi)` e le due condizioni sono in AND.
      // Un finto client che tiene solo l'ultima renderebbe verde una route rotta.
      const filtriIn: Record<string, string[]> = {}
      qb.in = (colonna: string, valori: string[]) => {
        filtriIn[colonna] = valori
        if (tabella === 'alunni') {
          qb.then = (res: (v: unknown) => unknown) => {
            const righe = [...h.sediAlunni.entries()]
              .map(([id, scuola_id]) => ({ id, scuola_id }))
              .filter((r) => !filtriIn.id || filtriIn.id.includes(r.id))
              .filter((r) => !filtriIn.scuola_id || filtriIn.scuola_id.includes(r.scuola_id))
            return Promise.resolve({ data: righe, error: null }).then(res)
          }
        }
        return qb
      }
      qb.insert = (v: unknown) => { h.scritture.push(tabella); void v; return qb }
      qb.update = (v: unknown) => { h.scritture.push(tabella); void v; return qb }
      qb.maybeSingle = async () => ({ data: null, error: null })
      qb.single = async () => ({ data: { id: 'm-1' }, error: null })
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { POST } from '@/app/api/gallery/route'

function richiesta(tagStudents: string[]) {
  return new NextRequest('http://localhost/api/gallery', {
    method: 'POST',
    body: JSON.stringify({
      uploaded_by: '77777777-7777-4777-8777-777777777777',
      file_url: 'https://esempio/foto.jpg',
      tag_students: tagStudents,
      scuola_id: AVERSA,
    }),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.sediAlunni = new Map([
    [MINORE_ALTRA_SEDE_1, 'sede-giugliano'],
    [MINORE_ALTRA_SEDE_2, 'sede-giugliano'],
    [MINORE_MIO, AVERSA],
  ])
  h.requireStaff.mockResolvedValue({ user: { id: 'u-aversa', role: 'segreteria', scuola_id: AVERSA } })
  h.resolveScuoleAttive.mockResolvedValue([AVERSA])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: AVERSA })
  // Il Privacy Lock direbbe «manca la liberatoria» e rivelerebbe i nomi: non deve
  // nemmeno essere interpellato su bambini che non sono nei plessi di chi chiede.
  h.alunniSenzaConsenso.mockResolvedValue([
    { id: MINORE_ALTRA_SEDE_1, nome: 'Nome Cognome Uno' },
    { id: MINORE_ALTRA_SEDE_2, nome: 'Nome Cognome Due' },
  ])
})

describe('POST /api/gallery — tagging di minori fuori dai propri plessi', () => {
  it('non rivela nomi né id, e il Privacy Lock non viene nemmeno interpellato', async () => {
    const res = await POST(richiesta([MINORE_ALTRA_SEDE_1, MINORE_ALTRA_SEDE_2]))

    expect(res.status).toBe(403)
    const corpo = JSON.stringify(await res.json())
    // L'asserzione che conta: il corpo non dice NIENTE di quei bambini.
    expect(corpo).not.toContain('Nome Cognome Uno')
    expect(corpo).not.toContain('Nome Cognome Due')
    expect(corpo).not.toContain(MINORE_ALTRA_SEDE_1)
    // …e il rifiuto arriva PRIMA del Privacy Lock, che leggerebbe l'anagrafica
    // di minori altrui per costruire la lista dei nomi.
    expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
    expect(h.scritture).toEqual([])
  })

  it('un solo tag estraneo basta a negare: non si pubblica «la parte lecita»', async () => {
    const res = await POST(richiesta([MINORE_MIO, MINORE_ALTRA_SEDE_1]))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('tutti i tag nei propri plessi ⇒ il controllo lascia passare al Privacy Lock', async () => {
    h.alunniSenzaConsenso.mockResolvedValue([])
    const res = await POST(richiesta([MINORE_MIO]))
    expect(res.status).not.toBe(403)
    expect(h.alunniSenzaConsenso).toHaveBeenCalledTimes(1)
  })
})
