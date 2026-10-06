import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// «NESSUN FIGLIO COLLEGATO» — il terzo caso di `GET /api/parent/students`.
//
// Il server distingueva due situazioni di elenco vuoto: i figli ci sono ma sono
// nascosti (`in_attesa`) e… niente. Un account con ZERO legami rientrava nel
// «niente»: la sua app girava in spinner senza spiegazione. Misurato il
// 2026-10-06 su una famiglia reale: il bambino era stato collegato a un secondo
// profilo della stessa persona, e quello che usava davvero non ne aveva nessuno.
//
// ⚠️ `senza_figli` si dichiara SOLO a lettura completa. `completo: false` è il
// segnale che una delle due tabelle dei legami non ha risposto: dire «nessun
// figlio» lì manderebbe in segreteria una famiglia con un guasto di lettura.
// =============================================================================

const h = vi.hoisted(() => ({
  esito: {
    righe: [] as Array<Record<string, unknown>>,
    totaleLegami: 0,
    nascosti: { archiviato: 0, ritirato: 0, 'senza-sezione': 0 },
    completo: true,
    errore: null as { code?: string; message?: string } | null,
  },
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: async () => ({ user: { id: 'P1' }, response: null }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = () => b
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    },
  }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliAttiviDiGenitore: async () => h.esito,
}))

import { GET } from '@/app/api/parent/students/route'

const chiedi = async () => {
  const res = await GET(new Request('http://localhost/api/parent/students?userId=P1') as never)
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  h.esito = {
    righe: [],
    totaleLegami: 0,
    nascosti: { archiviato: 0, ritirato: 0, 'senza-sezione': 0 },
    completo: true,
    errore: null,
  }
})

describe('GET /api/parent/students — senza_figli', () => {
  it('zero legami, lettura completa ⇒ senza_figli VERO e in_attesa falso', async () => {
    const body = await chiedi()
    expect(body.data).toEqual([])
    expect(body.senza_figli).toBe(true)
    expect(body.in_attesa).toBe(false)
  })

  it('legami che ci sono ma tutti nascosti ⇒ è «in attesa», NON «senza figli»', async () => {
    h.esito.totaleLegami = 1
    h.esito.nascosti['senza-sezione'] = 1
    const body = await chiedi()
    expect(body.in_attesa).toBe(true)
    expect(body.senza_figli, 'a questa famiglia il bambino c\'è: la frase è un\'altra').toBe(false)
  })

  it('lettura NON completa ⇒ senza_figli FALSO (un guasto di lettura non è un legame mancante)', async () => {
    h.esito.completo = false
    const body = await chiedi()
    expect(body.senza_figli).toBe(false)
    expect(body.in_attesa).toBe(false)
  })

  it('un figlio visibile ⇒ senza_figli FALSO', async () => {
    h.esito.righe = [{ id: 'A', nome: 'N', cognome: 'C', classe_sezione: 'X', scuola_id: null }]
    h.esito.totaleLegami = 1
    const body = await chiedi()
    expect(body.senza_figli).toBe(false)
    expect((body.data as unknown[]).length).toBe(1)
  })
})
