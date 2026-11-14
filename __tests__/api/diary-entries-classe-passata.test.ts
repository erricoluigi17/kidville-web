import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Lotto 8 — il docente CONSULTA il diario di una classe di un anno passato, e non lo scrive.
//
// Lettura: `?sectionId=&dellAnno=1&date=` dà gli eventi dei bambini di QUELL'ANNO (frequenze), solo dentro le date dell'anno,
// solo se la classe è fra quelle del docente. Scrittura: il POST resta su `assertAlunnoScrivibile` e risponde 403
// `SEZIONE_SOLA_LETTURA`. Il finto mette i bambini GIÀ nella classe nuova (dopo la ricopia): la lettura di oggi darebbe vuoto.
// =============================================================================

const DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2'
const SEC_ALTRUI = 'aaaa1111-0000-4000-8000-0000000000a3'
const ANNO_NUOVO = 'a0000000-0000-4000-8000-000000000027'
const ANNO_VECCHIO = 'a0000000-0000-4000-8000-000000000026'
const ALU_1 = 'c1111111-0000-4000-8000-000000000001'
const ALU_2 = 'c1111111-0000-4000-8000-000000000002'
const ALU_ALTRO = 'c1111111-0000-4000-8000-000000000009'
const GIORNO_NELL_ANNO = '2026-03-10'
const GIORNO_FUORI = '2026-10-10'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  visibili: null as null | (() => { data: unknown; error: unknown }),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
}))
vi.mock('@/lib/sezioni/risoluzione', () => ({
  risolviSezione: async (_s: unknown, _u: unknown, id: { sectionId?: string }) => ({ sectionIds: id.sectionId ? [id.sectionId] : [] }),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const rpc = { sezioni_visibili_docente: () => (h.visibili ? h.visibili() : { data: [], error: null }) }
  const crea = async () => creaFintoSupabase(h.db, [], { rpc })
  return { createAdminClient: crea, createClient: crea }
})

import { GET, POST } from '@/app/api/diary/entries/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_NUOVA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_NUOVO },
    { id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_VECCHIO },
    { id: SEC_ALTRUI, scuola_id: SEDE_A, name: 'Altra', anno_id: ANNO_VECCHIO },
  ],
  anni_sede: [
    { id: 'b1', anno_id: ANNO_NUOVO, scuola_id: SEDE_A, stato: 'corrente', inizio: '2026-09-01', fine: '2027-08-31' },
    { id: 'b2', anno_id: ANNO_VECCHIO, scuola_id: SEDE_A, stato: 'chiuso', inizio: '2025-09-01', fine: '2026-08-31' },
  ],
  alunni: [
    { id: ALU_1, nome: 'Uno', cognome: 'Alfa', classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
    { id: ALU_2, nome: 'Due', cognome: 'Beta', classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
    { id: ALU_ALTRO, nome: 'Altro', cognome: 'Delta', classe_sezione: 'Altra', section_id: SEC_ALTRUI, scuola_id: SEDE_A, anonimizzato_il: null },
  ],
  frequenze: [
    { id: 'f1', alunno_id: ALU_1, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'iscritto' },
    { id: 'f2', alunno_id: ALU_2, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'iscritto' },
    { id: 'f3', alunno_id: ALU_ALTRO, anno_id: ANNO_VECCHIO, section_id: SEC_ALTRUI, stato: 'iscritto' },
  ],
  eventi_diario: [
    { id: 'e1', alunno_id: ALU_1, tipo_evento: 'pranzo', orario_inizio: `${GIORNO_NELL_ANNO}T11:30:00+01:00` },
    { id: 'e2', alunno_id: ALU_ALTRO, tipo_evento: 'pranzo', orario_inizio: `${GIORNO_NELL_ANNO}T11:30:00+01:00` },
    { id: 'e3', alunno_id: ALU_1, tipo_evento: 'merenda', orario_inizio: `${GIORNO_FUORI}T10:00:00+02:00` },
  ],
  utenti_sezioni: [],
  utenti_scuole: [{ utente_id: DOCENTE, scuola_id: SEDE_A }],
  utenti: [],
})

const lettura = (sectionId: string, date: string, dellAnno = true) =>
  new NextRequest(`http://localhost/api/diary/entries?sectionId=${sectionId}&date=${date}${dellAnno ? '&dellAnno=1' : ''}`)
const idsEventi = async (res: Response) => ((await res.json()) as { id: string }[]).map((e) => e.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.visibili = () => ({
    data: [{ section_id: SEC_NUOVA, sola_lettura: false }, { section_id: SEC_VECCHIA, sola_lettura: true }],
    error: null,
  })
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/diary/entries — classe di un anno passato, in sola lettura', () => {
  it('🔴 LETTURA PERMESSA: gli eventi dei bambini di quell’anno, non quelli di una classe altrui', async () => {
    const res = await GET(lettura(SEC_VECCHIA, GIORNO_NELL_ANNO))
    expect(res.status).toBe(200)
    expect(await idsEventi(res)).toEqual(['e1'])
  })

  it('la data fuori dall’anno della classe dà vuoto (niente eventi di un anno diverso)', async () => {
    const res = await GET(lettura(SEC_VECCHIA, GIORNO_FUORI))
    expect(await res.json()).toEqual([])
  })

  it('🔴 CLASSE NON ASSEGNATA: il docente che non la ha fra le sue non legge niente', async () => {
    h.visibili = () => ({ data: [{ section_id: SEC_NUOVA, sola_lettura: false }], error: null })
    const res = await GET(lettura(SEC_VECCHIA, GIORNO_NELL_ANNO))
    expect(await res.json()).toEqual([])
  })

  it('🔴 ANNO IN PREPARAZIONE INVISIBILE: non è un anno passato, nessun roster dell’anno', async () => {
    h.db.anni_sede[1].stato = 'in_preparazione'
    const res = await GET(lettura(SEC_VECCHIA, GIORNO_NELL_ANNO))
    // Lettura di sempre: alunni.section_id punta alla classe nuova, quindi la classe vecchia risulta vuota.
    expect(await res.json()).toEqual([])
  })

  it('senza `dellAnno=1` la lettura è quella di sempre (la classe vecchia è vuota, section_id punta alla nuova)', async () => {
    const res = await GET(lettura(SEC_VECCHIA, GIORNO_NELL_ANNO, false))
    expect(await res.json()).toEqual([])
  })

  it('🔴 SCRITTURA RIFIUTATA: il POST su un bambino di una classe in sola lettura dà 403 SEZIONE_SOLA_LETTURA', async () => {
    // Il bambino sta ancora nella classe vecchia (anno che si sta chiudendo/passato): `assertAlunnoScrivibile` lo ferma.
    h.db.alunni[0].section_id = SEC_VECCHIA
    const res = await POST(new NextRequest('http://localhost/api/diary/entries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alunno_id: ALU_1, tipo_evento: 'pranzo' }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'SEZIONE_SOLA_LETTURA' })
  })
})
