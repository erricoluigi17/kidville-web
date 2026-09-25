import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// O1 — Obiettivi della primaria: «Modifica» in pagina (2026-09-24).
//
// La PATCH esisteva già, ma con `.loose()`: ogni chiave del corpo (meno `id` e
// `scuola_id`) arrivava così com'era alla UPDATE. Finché nessun pulsante la
// chiamava era un rischio teorico; da quando la pagina di configurazione ha
// «Modifica» in riga, la route accetta SOLO i due campi che l'interfaccia
// espone — codice e descrizione — e rifiuta una descrizione vuota, come fa il
// POST alla creazione.
//
// Ogni caso guarda la RIGA nel database finto dopo la chiamata, non solo lo
// stato: un 200 non dice quali colonne sono cambiate.
// =============================================================================

const OB = '66666666-1111-4111-8111-aaaaaaaaaaaa'
const ADMIN = '88888888-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as never, errori: h.errori })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { PATCH } from '@/app/api/admin/primaria/obiettivi/route'

const patch = (body: unknown) =>
  PATCH(
    new NextRequest('http://localhost/api/admin/primaria/obiettivi', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const riga = () => h.db.obiettivi_apprendimento.find((o) => o.id === OB)!

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }],
  utenti_scuole: [],
  utenti: [{ id: ADMIN, scuola_id: SEDE_A, ruolo: 'admin', nome: 'Dir', cognome: 'Uno', gradi: ['primaria'] }],
  obiettivi_apprendimento: [
    {
      id: OB,
      scuola_id: SEDE_A,
      materia_codice: 'italiano',
      livello: 2,
      codice: 'ITA-1',
      descrizione: 'OBIETTIVO-ORIGINALE',
      attivo: true,
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  const admin = { id: ADMIN, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A }
  h.requireStaff.mockResolvedValue({ user: admin })
  h.requireDocente.mockResolvedValue({ user: admin })
})

describe('PATCH /api/admin/primaria/obiettivi — la modifica in pagina', () => {
  it('codice e descrizione cambiano, già ripuliti dagli spazi', async () => {
    const res = await patch({ id: OB, codice: '  ITA-2 ', descrizione: '  Legge e comprende  ' })
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data).toMatchObject({ id: OB, codice: 'ITA-2', descrizione: 'Legge e comprende' })
    expect(riga()).toMatchObject({ codice: 'ITA-2', descrizione: 'Legge e comprende' })
  })

  it('le colonne che l\'interfaccia non espone NON arrivano alla UPDATE', async () => {
    const res = await patch({
      id: OB,
      descrizione: 'NUOVA',
      materia_codice: 'matematica',
      livello: 5,
      attivo: false,
      scuola_id: '99999999-9999-4999-8999-999999999999',
    })
    expect(res.status).toBe(200)
    expect(riga()).toEqual({
      id: OB,
      scuola_id: SEDE_A,
      materia_codice: 'italiano',
      livello: 2,
      codice: 'ITA-1',
      descrizione: 'NUOVA',
      attivo: true,
    })
  })

  it('codice svuotato ⇒ null, e la descrizione non si tocca', async () => {
    const res = await patch({ id: OB, codice: '   ' })
    expect(res.status).toBe(200)
    expect(riga().codice).toBeNull()
    expect(riga().descrizione).toBe('OBIETTIVO-ORIGINALE')
  })

  it('la sola descrizione non azzera il codice', async () => {
    const res = await patch({ id: OB, descrizione: 'SOLO-DESCRIZIONE' })
    expect(res.status).toBe(200)
    expect(riga().codice).toBe('ITA-1')
  })

  it('descrizione fatta di soli spazi: 400 e la riga resta quella', async () => {
    const res = await patch({ id: OB, descrizione: '    ' })
    expect(res.status).toBe(400)
    expect(riga().descrizione).toBe('OBIETTIVO-ORIGINALE')
  })

  it('nessun campo da modificare: 400, nessuna scrittura', async () => {
    const res = await patch({ id: OB })
    expect(res.status).toBe(400)
    expect(riga()).toMatchObject({ codice: 'ITA-1', descrizione: 'OBIETTIVO-ORIGINALE' })
  })

  it('codice già usato da un\'altra riga della stessa materia e classe (23505): 409 con codice, non la prosa di Postgres', async () => {
    h.errori = {
      'obiettivi_apprendimento:update': {
        code: '23505',
        message: 'duplicate key value violates unique constraint "obiettivi_apprendimento_scuola_id_materia_codice_livello_co_key"',
      },
    }
    const res = await patch({ id: OB, codice: 'ITA-9', descrizione: 'TENTATIVO' })
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('OBIETTIVO_CODICE_DUPLICATO')
    expect(corpo.error).not.toMatch(/duplicate key|constraint/)
    // La riga è rimasta com'era.
    expect(riga()).toMatchObject({ codice: 'ITA-1', descrizione: 'OBIETTIVO-ORIGINALE' })
  })

  it('un altro errore PostgREST resta un 500 (il 409 è SOLO per il 23505)', async () => {
    h.errori = { 'obiettivi_apprendimento:update': { code: '42501', message: 'permission denied' } }
    const res = await patch({ id: OB, descrizione: 'TENTATIVO' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBeUndefined()
  })
})
