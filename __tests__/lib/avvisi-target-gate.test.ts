import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppUser } from '@/lib/auth/require-staff'

// Il gate risolve le classi proprie del docente da utenti_sezioni →
// sections.name (helper `nomiSezioniDiUtente`): lo si mocka per isolare la
// logica di autorizzazione dal DB.
const h = vi.hoisted(() => ({ nomiSezioniDiUtente: vi.fn() }))
vi.mock('@/lib/sezioni/docenti', () => ({
  nomiSezioniDiUtente: (...args: unknown[]) => h.nomiSezioniDiUtente(...args),
}))

import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate'

const supabase = {} as never
const educator: AppUser = { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' }
const segreteria: AppUser = { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' }
const admin: AppUser = { id: 'adm-1', role: 'admin', scuola_id: 'sc-1' }

beforeEach(() => {
  vi.clearAllMocks()
  // Le classi assegnate all'educator.
  h.nomiSezioniDiUtente.mockResolvedValue(['Girasoli', 'Tulipani'])
})

describe('verificaTargetAvvisoDocente — educator', () => {
  it('rifiuta lo scope globale (403)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'globale', classi: [] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('rifiuta scope classe con array VUOTO (footgun che degrada a globale)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'classe', classi: [] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('rifiuta una classe non propria (403)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'classe', classi: ['Papaveri'] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('rifiuta se anche solo UNA classe non è propria', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'classe', classi: ['Girasoli', 'Papaveri'] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('consente le proprie classi (null)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'classe', classi: ['Girasoli'] })
    expect(res).toBeNull()
  })

  it('consente tutte le proprie classi insieme (null)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: 'classe', classi: ['Girasoli', 'Tulipani'] })
    expect(res).toBeNull()
  })

  it('tratta lo scope assente come non-classe → rifiuto', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, educator, { scope: null, classi: ['Girasoli'] })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})

describe('verificaTargetAvvisoDocente — staff/direzione non limitati', () => {
  it('segreteria: globale consentito (null)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, segreteria, { scope: 'globale', classi: [] })
    expect(res).toBeNull()
  })

  it('admin: classe arbitraria consentita (null)', async () => {
    const res = await verificaTargetAvvisoDocente(supabase, admin, { scope: 'classe', classi: ['Papaveri'] })
    expect(res).toBeNull()
  })

  it('staff non consulta le sezioni (nessuna chiamata a nomiSezioniDiUtente)', async () => {
    await verificaTargetAvvisoDocente(supabase, segreteria, { scope: 'classe', classi: ['Papaveri'] })
    expect(h.nomiSezioniDiUtente).not.toHaveBeenCalled()
  })
})
