import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// =============================================================================
// DUE ROTTE CHE PROMETTEVANO UN FILTRO DI SEDE E NON LO MANTENEVANO.
//
//  1. `admin/forms:GET` ACCETTAVA `scuola_id` E LO BUTTAVA VIA. Lo schema lo
//     dichiarava con un commento che diceva «ignorato», e la lista tornava
//     comunque quella di tutte le sedi attive. Una UI che manda un parametro che
//     il server ignora non fallisce: filtra, e mostra tutto. Nessun errore,
//     nessun log, nessun test rosso — solo un elenco più lungo di quello chiesto.
//
//  2. `documenti-firmati:GET` confrontava le sedi con `p === scuolaId`, cioè CON
//     DISTINZIONE DI MAIUSCOLE. In Postgres `uuid` è un TIPO: `'AAAA-…'` e
//     `'aaaa-…'` sono lo STESSO valore. In JavaScript sono due stringhe diverse,
//     e chi chiedeva la PROPRIA sede in maiuscolo si prendeva un 403 — misurato
//     sui dati veri il 2026-07-31, ed è la ragione per cui esiste
//     `formaConfronto`. Due danni: una lettura legittima negata, e un segnale di
//     sicurezza riempito di falsi positivi.
//
// `restringiSedi` chiude tutti e due i casi in un posto solo.
// =============================================================================

const SEDE = 'cccccccc-3333-4333-8333-cccccccccccc'
const ALTRA_SEDE = 'dddddddd-4444-4444-8444-dddddddddddd'
const SEDE_ESTRANEA = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'

// ─────────────────────────────────────────────────────────────────────────────
// 1. admin/forms:GET
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  moduli: [] as Record<string, unknown>[],
  /** Le sedi con cui `.in('scuola_id', …)` è stato chiamato. */
  sediFiltrate: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireStaff: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE, ALTRA_SEDE],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from() {
      let sedi: unknown[] | null = null
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = (col: string, vals: unknown[]) => {
        if (col === 'scuola_id') { sedi = vals; h.sediFiltrate.push(vals) }
        return b
      }
      b.order = () => b
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: sedi === null ? h.moduli : h.moduli.filter((m) => sedi!.includes(m.scuola_id)),
          error: null,
        }).then(res)
      return b
    },
  }),
}))

import { GET as FORMS } from '@/app/api/admin/forms/route'

const chiediForms = (qs = '') =>
  FORMS(new NextRequest(`http://localhost/api/admin/forms${qs}`, { headers: { 'x-user-id': 'u-1' } }))

beforeEach(() => {
  vi.clearAllMocks()
  h.moduli = []
  h.sediFiltrate = []
  h.requireDocente.mockResolvedValue({ user: { id: 'u-1', role: 'segreteria', scuola_id: SEDE } })
  h.requireStaff.mockResolvedValue({ user: { id: 'u-1', role: 'segreteria', scuola_id: SEDE } })
})

describe('GET /api/admin/forms — `scuola_id` non si accetta per poi ignorarlo', () => {
  it('`?scuola_id=` RESTRINGE davvero l\'elenco alla sede chiesta', async () => {
    h.moduli = [
      { id: 'm1', scuola_id: SEDE },
      { id: 'm2', scuola_id: ALTRA_SEDE },
    ]
    const res = await chiediForms(`?scuola_id=${ALTRA_SEDE}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string }[]
    expect(json.map((m) => m.id)).toEqual(['m2'])
    // …e il filtro parte verso il DATABASE, non applicato a valle su una lista
    // già arrivata intera.
    expect(h.sediFiltrate.at(-1)).toEqual([ALTRA_SEDE])
  })

  it('senza `scuola_id` l\'elenco resta quello di tutte le sedi attive', async () => {
    h.moduli = [
      { id: 'm1', scuola_id: SEDE },
      { id: 'm2', scuola_id: ALTRA_SEDE },
    ]
    const json = (await (await chiediForms()).json()) as { id: string }[]
    expect(json.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('una sede NON accessibile è 403, non l\'elenco di un\'altra sede', async () => {
    h.moduli = [{ id: 'm1', scuola_id: SEDE }]
    const res = await chiediForms(`?scuola_id=${SEDE_ESTRANEA}`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('la PROPRIA sede scritta in MAIUSCOLO resta la propria', async () => {
    h.moduli = [
      { id: 'm1', scuola_id: SEDE },
      { id: 'm2', scuola_id: ALTRA_SEDE },
    ]
    const res = await chiediForms(`?scuola_id=${SEDE.toUpperCase()}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string }[]
    // Esce la forma CANONICA del database, non la stringa arrivata dal client:
    // il resto del codice ci fa `===` con altri uuid già letti.
    expect(h.sediFiltrate.at(-1)).toEqual([SEDE])
    expect(json.map((m) => m.id)).toEqual(['m1'])
  })

  it('un `scuola_id` che non è un uuid è un 400: lo schema lo dichiara davvero', async () => {
    const res = await chiediForms('?scuola_id=quella-di-sopra')
    expect(res.status).toBe(400)
  })
})
