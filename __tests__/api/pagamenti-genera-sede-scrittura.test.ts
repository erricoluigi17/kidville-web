import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `pagamenti/genera` — una scrittura di massa non deduce il proprio perimetro
// da un NOME DI CLASSE.
//
// Il ramo senza `alunno_ids` selezionava gli alunni con
// `.in('scuola_id', scuolaRichiesta ? [scuolaRichiesta] : scuoleAccessibili)`
// in AND con `.eq('classe_sezione', …)`. Con tre sedi «2 ANNI» esiste in più
// plessi: «genera l'addebito per il 2 ANNI», senza `scuola_id` nel corpo,
// emetteva pagamenti — e le notifiche «pagamento emesso» — per i bambini di DUE
// sedi in una sola operazione. «Sede non indicata» veniva letto come «tutte
// quelle su cui posso operare» invece che come «ambiguo, chiedi»:
// `resolveScuolaScrittura` esiste esattamente per questo e risponde 400.
//
// I test guardano lo STATO DEL DATABASE (`db.pagamenti`, l'accumulatore
// `scritture`), non la forma delle chiamate: togliendo il resolver dalla route
// le righe dell'altra sede ricompaiono nel finto DB e i test tornano rossi.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  // Firma esplicita: serve a leggere `mock.calls[0][1]` (i parametri della
  // notifica) senza cast su una tupla vuota.
  notificaEvento: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  log: [] as unknown[][],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(a),
  logErrore: (...a: unknown[]) => h.log.push(a),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as unknown as Scrittura[],
      }) as never,
  }
})

import { POST } from '@/app/api/pagamenti/genera/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/pagamenti/genera', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const BASE = { descrizione: 'Gita al museo', importo: 10, scadenza: '2026-09-30' }

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ],
  alunni: [
    { id: ALU_A, scuola_id: SEDE_A, classe_sezione: OMONIMA, section_id: 'sec-a', stato: 'iscritto' },
    { id: ALU_B, scuola_id: SEDE_B, classe_sezione: OMONIMA, section_id: 'sec-b', stato: 'iscritto' },
  ],
  pagamenti: [],
  registro_modifiche: [],
})

const sediDi = (righe: Riga[]) => [...new Set(righe.map((r) => String(r.scuola_id)))].sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.log = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/genera — il ramo per nome-classe dichiara la sede', () => {
  it('admin multi-sede, classe omonima e nessuna sede: 400 e NESSUN pagamento', async () => {
    const res = await POST(post({ ...BASE, classe_sezione: OMONIMA }))
    expect(res.status).toBe(400)
    // Il corpo porta anche il `codice`, che è ciò che il client traduce: senza,
    // la segretaria che lavora in inglese leggerebbe questa frase in italiano
    // (collaudo 2026-07-31, localizzazione F2).
    expect(await res.json()).toEqual({
      error: 'Specificare la sede a cui si riferisce questa operazione',
      codice: 'SEDE_DA_SPECIFICARE',
    })
    expect(h.db.pagamenti).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('con la sede dichiarata: i pagamenti nascono SOLO in quella sede', async () => {
    const res = await POST(post({ ...BASE, classe_sezione: OMONIMA, scuola_id: SEDE_B }))
    expect(res.status).toBe(201)
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_B])
    expect((h.db.pagamenti as Riga[]).map((p) => p.alunno_id)).toEqual([ALU_B])
    // e la notifica è agganciata alla stessa sede, non a quella primaria dell'operatore
    const arg = h.notificaEvento.mock.calls[0][1] as { scuolaId: string; alunnoIds: string[] }
    expect(arg.scuolaId).toBe(SEDE_B)
    expect(arg.alunnoIds).toEqual([ALU_B])
  })

  it('una sola sede accessibile (segreteria): niente 400, si genera sulla sua', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await POST(post({ ...BASE, classe_sezione: OMONIMA }))
    expect(res.status).toBe(201)
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_A])
    expect((h.db.pagamenti as Riga[]).map((p) => p.alunno_id)).toEqual([ALU_A])
  })

  it('elenco esplicito di alunni: resta il gate per id, un estraneo ⇒ 403 e niente scritture', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await POST(post({ ...BASE, alunno_ids: [ALU_A, ALU_B] }))
    expect(res.status).toBe(403)
    expect(h.db.pagamenti).toEqual([])
    expect(h.scritture).toEqual([])
  })

  it('elenco esplicito: la notifica prende la sede DEGLI ALUNNI, non quella primaria di chi genera', async () => {
    const res = await POST(post({ ...BASE, alunno_ids: [ALU_B] }))
    expect(res.status).toBe(201)
    expect(sediDi(h.db.pagamenti as Riga[])).toEqual([SEDE_B])
    const arg = h.notificaEvento.mock.calls[0][1] as { scuolaId: string | null }
    expect(arg.scuolaId).toBe(SEDE_B)
  })
})
