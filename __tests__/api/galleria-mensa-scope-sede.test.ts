import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Galleria, mensa e Panic Alert.
//
//  · gallery PATCH/DELETE — l'autorizzazione si basava sull'INTERSEZIONE DEI
//    NOMI di classe fra il media e le classi del docente. Con «2 ANNI» presente
//    ad Aversa e a Cesa, la maestra di Aversa risultava autorizzata a modificare
//    e a CANCELLARE le foto dei bambini di Cesa.
//  · mensa/prenotazioni — il ramo staff (`STAFF_FORZA`) leggeva, prenotava e
//    disdiceva il pasto di qualunque alunno di qualunque sede.
//  · panic-alert — la sessione c'era, il RUOLO no: qualunque utente autenticato
//    (un genitore compreso) poteva far scattare l'allarme «ritiro non
//    autorizzato» su qualunque bambino, bloccandogli l'uscita.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const MEDIA_B = 'd1d1d1d1-1111-4111-8111-dddddddddddd'
const ED_A = '11111111-1111-4111-8111-111111111111'
const SEG_A = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
  requireParent: h.requireUser,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})
// Dipendenze non pertinenti all'isolamento, neutralizzate per non far fallire
// l'import dei moduli sotto test.
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({}),
  loadResolveOptions: async () => ({}),
  resolveMenuConfigId: async () => null,
  entroCutoff: () => true,
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuGiorno: () => null }))
vi.mock('@/lib/mensa/notify', () => ({ notificaSaldoBasso: async () => {} }))
vi.mock('@/lib/mensa/allergie-check', () => ({ controllaAllergie: async () => {} }))

import { PATCH as GALLERY_PATCH, DELETE as GALLERY_DELETE } from '@/app/api/gallery/route'
import { GET as MENSA_GET } from '@/app/api/mensa/prenotazioni/route'

const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: '2 ANNI' },
    { id: 'sec-b', scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: ED_A, section_id: 'sec-a' }],
  // `ruolo` è letto dalla tabella `utenti`, non da `auth.user`: la segreteria
  // ricadeva nel ramo `isAdmin`, che autorizzava QUALUNQUE media di QUALUNQUE
  // sede. È il caso da provare — con l'educator il difetto non si vedeva,
  // perché l'intersezione per nome non trovava comunque nulla nel fixture e il
  // test sarebbe stato verde per il motivo sbagliato.
  utenti: [{ id: SEG_A, ruolo: 'segreteria', scuola_id: SEDE_A }],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: '2 ANNI', section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: '2 ANNI', section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  // Media dell'altra sede, ma con lo STESSO nome di classe: è il caso che
  // l'intersezione per nome lasciava passare.
  galleria_media_v2: [
    { id: MEDIA_B, scuola_id: SEDE_B, target_classes: ['2 ANNI'], tag_students: [ALU_B], is_broadcast: false },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
})

describe('gallery PATCH/DELETE — la segreteria non tocca i media di un altro plesso', () => {
  it('DELETE: passa sul media della PROPRIA sede (nessun falso negativo)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    h.db.galleria_media_v2 = [
      { id: MEDIA_B, scuola_id: SEDE_A, target_classes: ['2 ANNI'], tag_students: [ALU_A], is_broadcast: false },
    ]
    const res = await GALLERY_DELETE(req(`/api/gallery?id=${MEDIA_B}`, 'DELETE'))
    expect(res.status).not.toBe(403)
  })

  it('PATCH: 403 sul media di un\'altra sede con lo stesso nome-classe', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    // La PATCH prende l'id dal BODY (la DELETE dalla query): passarlo nella
    // query darebbe un 400 di validazione prima del gate, e il test proverebbe
    // la cosa sbagliata.
    // `caption` e non `is_broadcast`: quest'ultimo ha una sua guardia di ruolo
    // che dava 403 anche SENZA il controllo di sede — il test sarebbe rimasto
    // verde rimettendo il difetto, cioe' non avrebbe provato niente.
    const res = await GALLERY_PATCH(req('/api/gallery', 'PATCH', { id: MEDIA_B, caption: 'manomesso' }))
    expect(res.status).toBe(403)
  })

  it('DELETE: 403 — non si cancellano le foto dei bambini dell\'altra sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GALLERY_DELETE(req(`/api/gallery?id=${MEDIA_B}`, 'DELETE'))
    expect(res.status).toBe(403)
  })
})

describe('mensa/prenotazioni — il ramo staff non è più libero', () => {
  it('GET: 403 sull\'alunno di un\'altra sede', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await MENSA_GET(req(`/api/mensa/prenotazioni?alunno_id=${ALU_B}&from=2026-07-01&to=2026-07-31`))
    expect(res.status).toBe(403)
  })

  it('GET: passa sull\'alunno della propria sede', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await MENSA_GET(req(`/api/mensa/prenotazioni?alunno_id=${ALU_A}&from=2026-07-01&to=2026-07-31`))
    expect(res.status).not.toBe(403)
  })
})
