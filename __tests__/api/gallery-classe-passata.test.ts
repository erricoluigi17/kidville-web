import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Lotto 8 — le FOTO di una classe di un anno passato: il docente le consulta e non le scrive.
//
// Lettura (`?classe=&sectionId=&dellAnno=1`): solo le foto con i bambini di QUELL'ANNO taggati (frequenze), solo dentro le date
// dell'anno, mai i broadcast (viaggiano per nome e il nome si ripete fra gli anni). Scrittura: POST e PATCH con una classe in
// sola lettura fra le `target_classes` rispondono 403 `SEZIONE_SOLA_LETTURA`. Il finto mette i bambini GIÀ nella classe nuova.
// =============================================================================

const DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2'
const ANNO_NUOVO = 'a0000000-0000-4000-8000-000000000027'
const ANNO_VECCHIO = 'a0000000-0000-4000-8000-000000000026'
const ALU_1 = 'c1111111-0000-4000-8000-000000000001'
const ALU_ALTRO = 'c1111111-0000-4000-8000-000000000009'
const FOTO_ANNO = '9e000000-0000-4000-8000-000000000001'
const FOTO_ALTRUI = '9e000000-0000-4000-8000-000000000002'
const FOTO_FUORI = '9e000000-0000-4000-8000-000000000003'
const FOTO_NOTTE_UTC = '9e000000-0000-4000-8000-000000000005'
const FOTO_COMPETENZA = '9e000000-0000-4000-8000-000000000006'
const FOTO_BROADCAST = '9e000000-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  visibili: null as null | (() => { data: unknown; error: unknown }),
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente, requireStaff: h.requireDocente }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
}))
vi.mock('@/lib/gallery/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/gallery/storage')>()),
  firmaMediaGalleria: async (_s: unknown, righe: unknown[]) => righe,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const rpc = { sezioni_visibili_docente: () => (h.visibili ? h.visibili() : { data: [], error: null }) }
  const crea = async () => creaFintoSupabase(h.db, [], { rpc })
  return { createAdminClient: crea, createClient: crea }
})

import { GET, POST, PATCH, DELETE } from '@/app/api/gallery/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_NUOVA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_NUOVO },
    { id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_VECCHIO },
  ],
  anni_sede: [
    { id: 'b1', anno_id: ANNO_NUOVO, scuola_id: SEDE_A, stato: 'corrente', inizio: '2026-09-01', fine: '2027-08-31' },
    { id: 'b2', anno_id: ANNO_VECCHIO, scuola_id: SEDE_A, stato: 'chiuso', inizio: '2025-09-01', fine: '2026-08-31' },
  ],
  alunni: [
    { id: ALU_1, nome: 'Uno', cognome: 'Alfa', classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
    { id: ALU_ALTRO, nome: 'Altro', cognome: 'Delta', classe_sezione: 'Altra', section_id: null, scuola_id: SEDE_A, anonimizzato_il: null },
  ],
  frequenze: [{ id: 'f1', alunno_id: ALU_1, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'iscritto' }],
  galleria_media_v2: [
    { id: FOTO_ANNO, anno_id: ANNO_VECCHIO, giorno_competenza: null, scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [ALU_1], is_broadcast: false, target_classes: null, created_at: '2026-03-10T10:00:00.000Z', eliminato_il: null },
    { id: FOTO_ALTRUI, scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [ALU_ALTRO], is_broadcast: false, target_classes: null, created_at: '2026-03-10T10:00:00.000Z', eliminato_il: null },
    { id: FOTO_FUORI, scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [ALU_1], is_broadcast: false, target_classes: null, created_at: '2026-10-10T10:00:00.000Z', eliminato_il: null },
    // R7 · il giorno di Roma: una foto delle 23:30 UTC del 31/08 è già del 1° settembre a Roma (fuori dall'anno vecchio), mentre
    // una con `giorno_competenza` dentro l'anno ci sta anche se `created_at` è fuori.
    { id: FOTO_NOTTE_UTC, anno_id: ANNO_NUOVO, giorno_competenza: null, scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [ALU_1], is_broadcast: false, target_classes: null, created_at: '2026-08-31T23:30:00.000Z', eliminato_il: null },
    { id: FOTO_COMPETENZA, anno_id: ANNO_VECCHIO, giorno_competenza: '2026-05-05', scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [ALU_1], is_broadcast: false, target_classes: null, created_at: '2026-10-20T10:00:00.000Z', eliminato_il: null },
    { id: FOTO_BROADCAST, scuola_id: SEDE_A, uploaded_by: DOCENTE, tag_students: [], is_broadcast: true, target_classes: ['TEST Infanzia'], created_at: '2026-03-10T10:00:00.000Z', eliminato_il: null },
  ],
  utenti: [{ id: DOCENTE, nome: 'Doc', cognome: 'Prova', ruolo: 'educator', scuola_id: SEDE_A }],
  utenti_sezioni: [],
  utenti_scuole: [{ utente_id: DOCENTE, scuola_id: SEDE_A }],
})

const lettura = (dellAnno = true, sectionId = SEC_VECCHIA) =>
  new NextRequest(`http://localhost/api/gallery?classe=${encodeURIComponent('TEST Infanzia')}&sectionId=${sectionId}${dellAnno ? '&dellAnno=1' : ''}`)
const ids = async (res: Response) => ((await res.json()) as { media: { id: string }[] }).media.map((m) => m.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.visibili = () => ({
    data: [{ section_id: SEC_NUOVA, sola_lettura: false }, { section_id: SEC_VECCHIA, sola_lettura: true }],
    error: null,
  })
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/gallery — classe di un anno passato, in sola lettura', () => {
  it('🔴 LETTURA PERMESSA: solo le foto dei bambini di quell’anno, dentro le date dell’anno, senza broadcast', async () => {
    const res = await GET(lettura())
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual([FOTO_ANNO, FOTO_COMPETENZA].sort())
  })

  it('🔴 R7 · la finestra è in GIORNI DI ROMA: la foto di mezzanotte UTC del 1° settembre è fuori, `giorno_competenza` dentro conta', async () => {
    const trovate = await ids(await GET(lettura()))
    expect(trovate).not.toContain(FOTO_NOTTE_UTC)
    expect(trovate).toContain(FOTO_COMPETENZA)
  })

  it('🔴 R3 · senza le date dell’anno (anni_sede senza `fine`) la lettura è VUOTA e l’errore è loggato col solo codice', async () => {
    h.db.anni_sede[1].fine = null
    const res = await GET(lettura())
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith('galleria', 'error', expect.objectContaining({ esito: 'periodo-anno-assente', error_code: 'PERIODO_ANNO_ASSENTE' }))
  })

  it('🔴 CLASSE NON ASSEGNATA: 403 «Sezione non assegnata al docente»', async () => {
    h.visibili = () => ({ data: [{ section_id: SEC_NUOVA, sola_lettura: false }], error: null })
    const res = await GET(lettura())
    expect(res.status).toBe(403)
  })

  it('🔴 ANNO IN PREPARAZIONE INVISIBILE: non è un anno passato, nessun roster dell’anno (lettura di sempre, coi broadcast)', async () => {
    h.db.anni_sede[1].stato = 'in_preparazione'
    h.db.frequenze[0].alunno_id = ALU_ALTRO
    const res = await GET(lettura())
    const trovate = await ids(res)
    // Con il roster dell'anno sarebbe uscita FOTO_ALTRUI e mai il broadcast: qui vale la lettura per nome.
    expect(trovate).toContain(FOTO_BROADCAST)
    expect(trovate).not.toContain(FOTO_ALTRUI)
  })

  it('senza `dellAnno=1` la lettura è quella di sempre (per NOME, con i broadcast)', async () => {
    const res = await GET(lettura(false))
    expect(await ids(res)).toContain(FOTO_BROADCAST)
  })
})

describe('scritture della galleria su una classe in sola lettura', () => {
  const corpo = (extra: Record<string, unknown>) => JSON.stringify({ file_url: 'x/y.jpg', file_type: 'foto', ...extra })

  it('🔴 POST con una classe in sola lettura fra le `target_classes`: 403 SEZIONE_SOLA_LETTURA', async () => {
    // La sola classe di quel nome nell'anno attivo è la nuova; quella vecchia è in sola lettura e l'unica del docente col nome.
    h.db.sections = [{ id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_VECCHIO }]
    h.visibili = () => ({ data: [{ section_id: SEC_VECCHIA, sola_lettura: true }], error: null })
    h.db.anni_sede[1].stato = 'in_chiusura'
    const res = await POST(new NextRequest('http://localhost/api/gallery', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo({ target_classes: ['TEST Infanzia'] }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: expect.stringMatching(/SEZIONE_(SOLA_LETTURA|IN_CHIUSURA)/) })
  })

  it('🔴 PATCH con una classe in sola lettura fra le `target_classes`: 403', async () => {
    h.db.sections = [{ id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_VECCHIO }]
    h.visibili = () => ({ data: [{ section_id: SEC_VECCHIA, sola_lettura: true }], error: null })
    h.db.anni_sede[1].stato = 'in_chiusura'
    const res = await PATCH(new NextRequest('http://localhost/api/gallery', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: FOTO_ANNO, target_classes: ['TEST Infanzia'] }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: expect.stringMatching(/SEZIONE_(SOLA_LETTURA|IN_CHIUSURA)/) })
  })
})

describe('R2 · foto già esistenti di un anno chiuso o in chiusura: il docente non le elimina né le modifica', () => {
  const elimina = (id: string) => new NextRequest(`http://localhost/api/gallery?id=${id}`, { method: 'DELETE' })
  const modifica = (id: string, extra: Record<string, unknown> = { caption: 'x' }) => new NextRequest('http://localhost/api/gallery', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...extra }),
  })
  const codice = async (res: Response) => ((await res.json()) as { codice?: string }).codice

  for (const [stato, atteso] of [['chiuso', 'SEZIONE_SOLA_LETTURA'], ['in_chiusura', 'SEZIONE_IN_CHIUSURA']] as const) {
    it(`🔴 DELETE di una sua foto dell’anno ${stato}: 403 ${atteso} (anche se l’ha caricata lui)`, async () => {
      h.db.anni_sede[1].stato = stato
      const res = await DELETE(elimina(FOTO_ANNO))
      expect(res.status).toBe(403)
      expect(await codice(res)).toBe(atteso)
      expect(h.logEvento).toHaveBeenCalledWith('auth', 'warn', expect.objectContaining({ tipo: 'riga-anno-sola-lettura', azione: 'gallery:DELETE', anno: ANNO_VECCHIO }))
    })

    it(`🔴 PATCH senza target_classes (didascalia, tag) dell’anno ${stato}: 403 ${atteso}`, async () => {
      h.db.anni_sede[1].stato = stato
      const res = await PATCH(modifica(FOTO_ANNO, { caption: 'nuova', tag_students: [ALU_1] }))
      expect(res.status).toBe(403)
      expect(await codice(res)).toBe(atteso)
    })
  }

  it('l’anno si ricava dalla RIGA: una foto dell’anno in corso (anno_id nuovo) non è toccata dal controllo', async () => {
    const res = await PATCH(modifica(FOTO_NOTTE_UTC))
    expect(res.status).not.toBe(403)
  })

  it('🔴 la Direzione NON ha sola lettura: la stessa DELETE e la stessa PATCH superano il controllo', async () => {
    h.db.anni_sede[1].stato = 'chiuso'
    h.db.utenti[0].ruolo = 'admin'
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE_A } })
    const del = await DELETE(elimina(FOTO_ANNO))
    const pat = await PATCH(modifica(FOTO_ANNO))
    for (const res of [del, pat]) expect(res.status).not.toBe(403)
    expect(h.logEvento).not.toHaveBeenCalledWith('auth', 'warn', expect.objectContaining({ tipo: 'riga-anno-sola-lettura' }))
  })
})
