import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * GET dei voti del genitore — `materieClasse` (compito G2, spec 2026-09-24).
 *
 * Il modulo «Dichiara impreparato» della pagina Voti deve offrire TUTTE le
 * materie attive della classe, anche quelle che non hanno ancora un voto: `data`
 * elenca solo le materie valutate, quindi da sola avrebbe tolto al genitore le
 * altre. Il finto client APPLICA i filtri: una materia di un'altra classe o una
 * materia disattivata che comparisse qui renderebbe rossa la prova.
 */

const SEDE = 'a1a1a1a1-0000-4000-8000-00000000000a'
const SEZ = 'd4d4d4d4-0000-4000-8000-00000000000d'
const SEZ_ALTRA = 'd5d5d5d5-0000-4000-8000-00000000000d'
const ALUNNO = 'c3c3c3c3-1111-4111-8111-cccccccccccc'
const IO = 'e1e1e1e1-0000-4000-8000-00000000000e'
const MAT = '0a0a0a0a-0000-4000-8000-0000000000aa'
const MAT_SENZA_VOTI = '0b0b0b0b-0000-4000-8000-0000000000bb'
const MAT_SPENTA = '0d0d0d0d-0000-4000-8000-0000000000dd'
const MAT_ALTRA_CLASSE = '0c0c0c0c-0000-4000-8000-0000000000cc'

const h = vi.hoisted(() => ({ db: {} as DBFinto, tabelle: [] as string[] }))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: async () => ({
    user: { id: IO, role: 'genitore', ruolo: 'genitore', ruoli: ['genitore'], scuola_id: null },
  }),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { rpc: {} })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET } from '@/app/api/parent/primaria/valutazioni/route'

const UN_ORA_FA = new Date(Date.now() - 60 * 60_000).toISOString()

beforeEach(() => {
  h.tabelle = []
  h.db = {
    alunni: [{ id: ALUNNO, section_id: SEZ, scuola_id: SEDE }],
    admin_settings: [{ scuola_id: SEDE, notif_buffer_valutazioni_min: 10 }],
    materie: [
      { id: MAT_SENZA_VOTI, nome: 'Scienze', section_id: SEZ, attiva: true, ordine: 2 },
      { id: MAT, nome: 'Matematica', section_id: SEZ, attiva: true, ordine: 1 },
      { id: MAT_SPENTA, nome: 'Latino', section_id: SEZ, attiva: false, ordine: 3 },
      { id: MAT_ALTRA_CLASSE, nome: 'Storia', section_id: SEZ_ALTRA, attiva: true, ordine: 1 },
    ],
    valutazioni: [
      {
        id: 'v-1', alunno_id: ALUNNO, materia_id: MAT, tipo: 'orale', modalita: 'giudizio',
        giudizio_sintetico: 'Buono', giudizio_testo: null, creato_il: UN_ORA_FA, argomento: null,
      },
    ],
    giustifiche_didattiche: [],
  }
})

async function leggi() {
  const res = await GET(new NextRequest(`http://localhost/api/parent/primaria/valutazioni?studentId=${ALUNNO}`))
  expect(res.status).toBe(200)
  return (await res.json()) as {
    data: Array<{ materiaId: string }>
    materieClasse: Array<{ id: string; nome: string }>
  }
}

describe('GET dei voti — le materie della classe per il modulo impreparato', () => {
  it('manda tutte le materie ATTIVE della classe, anche senza voti, nell’ordine della classe', async () => {
    const corpo = await leggi()
    // `data` ha solo la materia valutata: il modulo non può partire da qui.
    expect(corpo.data.map((m) => m.materiaId)).toEqual([MAT])
    expect(corpo.materieClasse).toEqual([
      { id: MAT, nome: 'Matematica' },
      { id: MAT_SENZA_VOTI, nome: 'Scienze' },
    ])
  })

  it('non manda materie di un’altra classe né materie disattivate', async () => {
    const ids = (await leggi()).materieClasse.map((m) => m.id)
    expect(ids).not.toContain(MAT_ALTRA_CLASSE)
    expect(ids).not.toContain(MAT_SPENTA)
  })
})
