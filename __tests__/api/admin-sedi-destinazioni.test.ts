import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import {
  SEDE_A, SEDE_B, SEDE_C, SEDE_E2E,
  NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C, NOME_SEDE_E2E,
} from '../fixtures/sedi'

// =============================================================================
// `GET /api/admin/sedi/destinazioni` — DOVE si può spostare un bambino.
//
// ─── TRE RISPOSTE, NON DUE ───────────────────────────────────────────────────
//
// L'elenco vuoto è ambiguo, e l'ambiguità qui costa: «non ci sono sedi dove
// spostarlo» e «non sono riuscito a leggere le sedi» producono lo stesso array
// vuoto, e un'interfaccia che le confonde dice a una segretaria una cosa FALSA
// con l'aria di un fatto. Perciò la route distingue:
//
//   1. destinazioni ⇒ 200, `data` piena, `motivo: 'ok'`;
//   2. nessuna destinazione PER RUOLO/PERIMETRO ⇒ 200, `data: []`,
//      `motivo: 'nessuna-destinazione'` — è una risposta, non un guasto;
//   3. lettura ROTTA ⇒ **non 200**, con `codice`. Non deve MAI arrivare al
//      client come «non ci sono sedi».
//
// ─── PERCHÉ IL FINTO CLIENT È QUELLO CHE PROIETTA ────────────────────────────
//
// `finto-supabase` dichiara di non emulare la proiezione di `select()`: le righe
// tornano INTERE. Con quello, una `select('id')` che dimenticasse `nome`
// resterebbe verde — il nome uscirebbe lo stesso dal fixture — mentre in
// produzione PostgREST restituirebbe solo `id` e il selettore di sede mostrerebbe
// tre voci senza etichetta. È la forma di guasto che il 2026-09-02 ha tenuto
// ferma la fatturazione. Qui si usa `creaFintoSupabaseConProiezione`, che
// proietta come PostgREST: «il nome della sede arriva al client» è una proprietà
// VERIFICATA, non asserita.
// =============================================================================

const ADMIN = 'aaaa0000-0000-4000-8000-000000000001'
const SEGRETERIA = 'aaaa0000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
  proiezioni: [] as Proiezione[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  return {
    createAdminClient: async () =>
      creaFintoSupabaseConProiezione(h.db, h.tabelle, { errori: h.errori }, h.proiezioni),
  }
})

import { GET } from '@/app/api/admin/sedi/destinazioni/route'

const req = () => new NextRequest('http://localhost/api/admin/sedi/destinazioni')

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_C, nome: NOME_SEDE_C },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_C, attiva: true },
  ],
  // La Direzione è multi-plesso solo via `utenti_scuole`: qui NE HA DUE su tre.
  // Serve a provare che le destinazioni della Direzione sono le sedi REALI e non
  // le sue — è tutto il punto del trasferimento fra plessi.
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/admin/sedi/destinazioni', () => {
  it('la Direzione riceve TUTTE le sedi reali, anche quelle che non sono sue', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: { id: string; nome: string }[]; motivo: string }
    expect(corpo.data.map((s) => s.id)).toEqual([SEDE_A, SEDE_B, SEDE_C])
    expect(corpo.motivo).toBe('ok')
  })

  it('la sede di collaudo E2E non compare fra le destinazioni di un bambino vero', async () => {
    const res = await GET(req())
    const corpo = (await res.json()) as { data: { id: string }[] }
    expect(corpo.data.map((s) => s.id)).not.toContain(SEDE_E2E)
  })

  it('ogni destinazione porta il NOME, non solo l\'uuid (proiezione verificata)', async () => {
    const res = await GET(req())
    const corpo = (await res.json()) as { data: { id: string; nome: string }[] }
    expect(corpo.data.map((s) => s.nome)).toEqual([NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C])
    // La prova che il nome non arriva "per caso" dal fixture: la select lo chiede.
    const suSchools = h.proiezioni.filter((p) => p.tabella === 'schools')
    expect(suSchools.length).toBeGreaterThan(0)
    expect(suSchools.every((p) => /\bnome\b/.test(p.colonne) || p.colonne === '*')).toBe(true)
  })

  it('la segreteria riceve SOLO la propria sede: il trasferimento fra plessi è della Direzione', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: { id: string }[]; motivo: string }
    expect(corpo.data.map((s) => s.id)).toEqual([SEDE_A])
    expect(corpo.motivo).toBe('ok')
  })

  it('nessuna destinazione per PERIMETRO ⇒ 200 con l\'elenco vuoto e il motivo detto', async () => {
    // Segreteria senza sede: l'elenco è vuoto, ma non è successo niente di rotto.
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: null } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: unknown[]; motivo: string }
    expect(corpo.data).toEqual([])
    expect(corpo.motivo).toBe('nessuna-destinazione')
  })

  it('lettura ROTTA ⇒ NON 200 e nessun elenco: «vuoto» non si spaccia per «nessuna sede»', async () => {
    h.errori = { schools: { code: 'PGRST301', message: 'permission denied' } }
    const res = await GET(req())
    expect(res.status).not.toBe(200)
    const corpo = (await res.json()) as { data?: unknown; codice?: string; motivo?: string }
    // Il client non deve poter leggere un elenco (vuoto) da una risposta di guasto.
    expect(corpo.data).toBeUndefined()
    expect(corpo.motivo).toBeUndefined()
    expect(corpo.codice).toBe('LETTURA_FALLITA')
  })

  it('il RIFIUTO lascia una riga sua, distinta da quella di `sediReali`', async () => {
    // ⚠️ Non basta contare le righe `error` con questa `operazione`: `sediReali`
    // ne scrive già una (`schools-non-leggibile`) proprio con questo nome, quindi
    // un'asserzione generica sarebbe verde anche togliendo il ramo di rifiuto
    // dalla route. Si asserisce l'esito che solo la route può scrivere.
    h.errori = { schools: { code: 'PGRST301', message: 'permission denied' } }
    await GET(req())
    const righe = h.logEvento.mock.calls.filter(
      (c) => c[1] === 'error'
        && (c[2] as { esito?: string })?.esito === 'destinazioni-non-lette'
        && (c[2] as { operazione?: string })?.operazione === 'admin/sedi/destinazioni:GET',
    )
    expect(righe).toHaveLength(1)
  })

  it('il gate viene prima dei dati, e non è allargato', async () => {
    // `requireStaff` senza secondo argomento ammette `['admin','coordinator','segreteria']`:
    // chi non può spostare non deve nemmeno sapere quali sedi esistono. L'asserzione
    // sull'argomento diventa rossa il giorno in cui qualcuno allarga quell'elenco.
    h.requireStaff.mockResolvedValue({
      response: NextResponse.json({ error: 'negato' }, { status: 403 }),
    })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.requireStaff.mock.calls[0].slice(1)).toEqual([])
    expect(h.tabelle).toEqual([])
  })
})
