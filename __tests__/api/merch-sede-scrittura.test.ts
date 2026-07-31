import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// W2-M — Merchandise: articoli e fornitori DICHIARANO la sede.
//
// Difetto chiuso qui (rilievo R9 dell'audit 2026-07-31). La riga era
// `auth.user.scuola_id && plessi.includes(auth.user.scuola_id) ? auth.user.scuola_id
// : plessi[0]`, e sembrava un ripiego «prendi il primo plesso». Non lo era: siccome
// `utenti.scuola_id` è NOT NULL ed è il PRIMO elemento di `scuoleDiUtente`, il ramo
// `plessi[0]` è irraggiungibile e vinceva SEMPRE la sede primaria dell'operatore.
// Lo schema zod non aveva nemmeno il campo `scuola_id`: non c'era modo di dire dove
// si stava scrivendo. L'admin che lavorava su Aversa creava articolo e fornitore a
// Giugliano — senza errore, senza log, e senza poterlo scoprire se non confrontando
// i dati.
//
// Il finto client scrive DAVVERO: ogni caso asserisce lo stato esatto E la riga
// finita in tabella (accumulatore `scritture`), mai una negazione.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_SEGRETERIA = 'd0000000-0000-4000-8000-0000000005e6'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
  }
})

import { POST as ARTICOLI_POST } from '@/app/api/admin/merch/articoli/route'
import { POST as FORNITORI_POST } from '@/app/api/admin/merch/fornitori/route'

const dbBase = (): DBFinto => ({
  // La Direzione è multi-plesso via il ponte: sede primaria A, più B.
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  divise_articoli: [],
  merch_fornitori: [],
  audit_scritture_docente: [],
})

function postReq(url: string, body: Record<string, unknown>, cookie?: string): NextRequest {
  return {
    url,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const articolo = (extra: Record<string, unknown> = {}) => ({
  nome: 'Polo estiva',
  taglie: ['S', 'M'],
  prezzo: 18,
  ...extra,
})
const fornitore = (extra: Record<string, unknown> = {}) => ({
  nome: 'Tessuti Campania',
  ...extra,
})

const postArticolo = (body: Record<string, unknown>, cookie?: string) =>
  ARTICOLI_POST(postReq('http://localhost/api/admin/merch/articoli', body, cookie))
const postFornitore = (body: Record<string, unknown>, cookie?: string) =>
  FORNITORI_POST(postReq('http://localhost/api/admin/merch/fornitori', body, cookie))

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireStaff.mockResolvedValue({
    user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A },
  })
})

describe('POST /api/admin/merch/articoli — la sede si dichiara', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400 e NIENTE in catalogo', async () => {
    const res = await postArticolo(articolo())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(scrittureSu('divise_articoli')).toEqual([])
    expect(h.db.divise_articoli).toEqual([])
  })

  it('`scuola_id` dichiarato ⇒ 201 in QUELLA sede, non nella primaria dell\'operatore', async () => {
    const res = await postArticolo(articolo({ scuola_id: SEDE_B }))

    expect(res.status).toBe(201)
    const righe = scrittureSu('divise_articoli')
    expect(righe).toHaveLength(1)
    expect(righe[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, nome: 'Polo estiva' })
    expect(h.db.divise_articoli).toHaveLength(1)
    expect(h.db.divise_articoli[0].scuola_id).toBe(SEDE_B)
  })

  it('SedeSelector su una sola sede ⇒ 201 in quella sede', async () => {
    const res = await postArticolo(articolo(), SEDE_B)

    expect(res.status).toBe(201)
    expect(scrittureSu('divise_articoli')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('l\'audit GDPR porta la sede scritta, non quella dell\'operatore', async () => {
    const res = await postArticolo(articolo({ scuola_id: SEDE_B }))

    expect(res.status).toBe(201)
    const audit = scrittureSu('audit_scritture_docente')
    expect(audit).toHaveLength(1)
    expect(audit[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      entita_tipo: 'merch_articolo',
      azione: 'insert',
    })
  })

  it('utente con UNA sola sede che ne dichiara un\'altra ⇒ 403, nessun articolo', async () => {
    // ⚠️ Comportamento atteso CAMBIATO il 2026-07-31. Qui si asseriva
    // «201 nella sua», cioè: la segreteria di A chiede di creare l'articolo su
    // C e il server lo crea su A — duecentouno, nessun errore, nessun log, il
    // dato in un plesso che nessuno aveva nominato. È il ripiego che
    // `resolveScuolaScrittura` faceva quando la sede dichiarata non era
    // accessibile, ed è la forma esatta del difetto misurato su
    // `mensa/alternative` e `gallery`. Ora si nega.
    h.requireStaff.mockResolvedValue({
      user: { id: ID_SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A },
    })
    const res = await postArticolo(articolo({ scuola_id: SEDE_C }))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile' })
    // Non basta lo status: la prova è che nel database non è comparso niente,
    // né l'articolo né la sua riga di audit.
    expect(scrittureSu('divise_articoli')).toEqual([])
    expect(scrittureSu('audit_scritture_docente')).toEqual([])
  })
})

describe('POST /api/admin/merch/fornitori — la sede si dichiara', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400 e nessun fornitore creato', async () => {
    const res = await postFornitore(fornitore())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(scrittureSu('merch_fornitori')).toEqual([])
    expect(h.db.merch_fornitori).toEqual([])
  })

  it('`scuola_id` dichiarato ⇒ 201 in QUELLA sede', async () => {
    const res = await postFornitore(fornitore({ scuola_id: SEDE_B }))

    expect(res.status).toBe(201)
    const righe = scrittureSu('merch_fornitori')
    expect(righe).toHaveLength(1)
    expect(righe[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, nome: 'Tessuti Campania' })
    expect(h.db.merch_fornitori[0].scuola_id).toBe(SEDE_B)
  })

  it('SedeSelector su una sola sede ⇒ 201 in quella sede', async () => {
    const res = await postFornitore(fornitore(), SEDE_B)

    expect(res.status).toBe(201)
    expect(scrittureSu('merch_fornitori')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })
})
