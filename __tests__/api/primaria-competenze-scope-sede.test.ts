import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W2-G — Primaria e competenze: gli handler dimenticati.
//
// PR #60 aveva messo in scope il GET di `admin/primaria/materie` e le due
// letture di `admin/competenze`, lasciando nudi PROPRIO gli handler che
// scrivono: `competenze/genera` GENERA e FIRMA (FEA del dirigente) i certificati
// delle competenze — un documento nominativo di un minore con valore legale — e
// bastava conoscere l'uuid di una sezione di un altro plesso.
//
// Qui si verifica, per OGNI handler, lo stato esatto della risposta E l'effetto
// sul database finto (accumulatore `scritture`): «403» da solo non prova che la
// riga altrui sia rimasta intatta, e un `not.toBe(403)` non prova nulla del
// tutto (è la forma dei due falsi verdi trovati il 2026-07-30).
// =============================================================================

const SEZ_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const CERT_A = '33333333-1111-4111-8111-aaaaaaaaaaaa'
const CERT_B = '33333333-2222-4222-8222-bbbbbbbbbbbb'
const MAT_A = '44444444-1111-4111-8111-aaaaaaaaaaaa'
const MAT_B = '44444444-2222-4222-8222-bbbbbbbbbbbb'
const PER_A = '55555555-1111-4111-8111-aaaaaaaaaaaa'
const PER_B = '55555555-2222-4222-8222-bbbbbbbbbbbb'
const OB_A = '66666666-1111-4111-8111-aaaaaaaaaaaa'
const OB_B = '66666666-2222-4222-8222-bbbbbbbbbbbb'
const DOC_A = '77777777-1111-4111-8111-aaaaaaaaaaaa'
const DOC_B = '77777777-2222-4222-8222-bbbbbbbbbbbb'
const ADMIN = '88888888-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  generaCertificato: vi.fn(),
  seedCertificato: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/competenze/certificato-store', () => ({
  generaCertificato: h.generaCertificato,
  seedCertificato: h.seedCertificato,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as never })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { POST as GENERA } from '@/app/api/admin/competenze/genera/route'
import { POST as COMP_POST, PATCH as COMP_PATCH } from '@/app/api/admin/competenze/route'
import {
  POST as MATERIE_POST,
  PATCH as MATERIE_PATCH,
  DELETE as MATERIE_DELETE,
} from '@/app/api/admin/primaria/materie/route'
import {
  GET as PERIODI_GET,
  POST as PERIODI_POST,
  PATCH as PERIODI_PATCH,
  DELETE as PERIODI_DELETE,
} from '@/app/api/admin/primaria/scrutinio-periodi/route'
import {
  PATCH as OBIETTIVI_PATCH,
  DELETE as OBIETTIVI_DELETE,
} from '@/app/api/admin/primaria/obiettivi/route'
import { PATCH as GRADI_PATCH } from '@/app/api/admin/primaria/docente-gradi/route'

// ─── helper richiesta ────────────────────────────────────────────────────────
const req = (url: string, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined)

const conCorpo = (url: string, metodo: string, body: unknown, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method: metodo,
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const scritte = (tabella: string): Scrittura[] =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: 'Kidville Alfa' },
    { id: SEDE_B, nome: 'Kidville Beta' },
  ],
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '5 ANNI' },
    { id: SEZ_B, scuola_id: SEDE_B, name: '5 ANNI' },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
  utenti: [
    { id: ADMIN, scuola_id: SEDE_A, ruolo: 'admin', nome: 'Dir', cognome: 'Uno', gradi: ['infanzia'] },
    { id: DOC_A, scuola_id: SEDE_A, ruolo: 'educator', nome: 'Doc', cognome: 'Alfa', gradi: ['infanzia'] },
    { id: DOC_B, scuola_id: SEDE_B, ruolo: 'educator', nome: 'Doc', cognome: 'Beta', gradi: ['infanzia'] },
  ],
  certificati_competenze: [
    { id: CERT_A, section_id: SEZ_A, alunno_id: 'al-a', stato: 'bozza' },
    { id: CERT_B, section_id: SEZ_B, alunno_id: 'al-b', stato: 'bozza' },
  ],
  certificato_competenza_livelli: [],
  alunni: [
    { id: 'al-a', section_id: SEZ_A, scuola_id: SEDE_A },
    { id: 'al-b', section_id: SEZ_B, scuola_id: SEDE_B },
  ],
  materie: [
    { id: MAT_A, section_id: SEZ_A, scuola_id: SEDE_A, nome: 'Italiano', codice: 'ITA', ordine: 1 },
    { id: MAT_B, section_id: SEZ_B, scuola_id: SEDE_B, nome: 'Italiano', codice: 'ITA', ordine: 1 },
  ],
  materie_preset: [
    { livello: 1, attivo: true, nome: 'Italiano', codice: 'ITA', e_civica: false, turno_mensa: false, ordine: 1 },
  ],
  scrutinio_periodi: [
    { id: PER_A, scuola_id: SEDE_A, anno_scolastico: '2025/2026', nome: 'PERIODO-ALFA', ordine: 1, attivo: true },
    { id: PER_B, scuola_id: SEDE_B, anno_scolastico: '2025/2026', nome: 'PERIODO-BETA', ordine: 1, attivo: true },
  ],
  obiettivi_apprendimento: [
    { id: OB_A, scuola_id: SEDE_A, materia_codice: 'ITA', livello: 1, descrizione: 'OBIETTIVO-ALFA' },
    { id: OB_B, scuola_id: SEDE_B, materia_codice: 'ITA', livello: 1, descrizione: 'OBIETTIVO-BETA' },
  ],
  audit_scritture_docente: [],
})

/** L'admin mono-plesso: la sola SEDE_A. */
const soloA = { id: ADMIN, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A }

/** L'admin di Direzione con il ponte verso la seconda sede. */
const conPonte = () => {
  h.db.utenti_scuole = [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: soloA })
  h.requireDocente.mockResolvedValue({ user: soloA })
  h.generaCertificato.mockResolvedValue({ pdf: Buffer.from('%PDF-1') })
  h.seedCertificato.mockResolvedValue({ certificatoId: CERT_A })
})

// =============================================================================
describe('POST /api/admin/competenze/genera — la firma FEA non esce dal proprio plesso', () => {
  it('sectionId di un altro plesso: 403, e nessun certificato viene generato né firmato', async () => {
    const res = await GENERA(conCorpo('/api/admin/competenze/genera', 'POST', { sectionId: SEZ_B }))
    expect(res.status).toBe(403)
    expect(h.generaCertificato).not.toHaveBeenCalled()
  })

  it('certificatoId di un altro plesso: 403, e la firma non parte', async () => {
    const res = await GENERA(conCorpo('/api/admin/competenze/genera', 'POST', { certificatoId: CERT_B }))
    expect(res.status).toBe(403)
    expect(h.generaCertificato).not.toHaveBeenCalled()
  })

  it('certificatoId inesistente: 404, e la firma non parte', async () => {
    const res = await GENERA(
      conCorpo('/api/admin/competenze/genera', 'POST', { certificatoId: '99999999-9999-4999-8999-999999999999' })
    )
    expect(res.status).toBe(404)
    expect(h.generaCertificato).not.toHaveBeenCalled()
  })

  it('sectionId del proprio plesso: 200 e il certificato viene generato', async () => {
    const res = await GENERA(conCorpo('/api/admin/competenze/genera', 'POST', { sectionId: SEZ_A }))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.generati).toBe(1)
    expect(h.generaCertificato).toHaveBeenCalledTimes(1)
    expect(h.generaCertificato).toHaveBeenCalledWith(expect.anything(), CERT_A, ADMIN, true)
  })

  it('certificatoId del proprio plesso: 200 e la firma parte', async () => {
    const res = await GENERA(conCorpo('/api/admin/competenze/genera', 'POST', { certificatoId: CERT_A }))
    expect(res.status).toBe(200)
    expect(h.generaCertificato).toHaveBeenCalledWith(expect.anything(), CERT_A, ADMIN, true)
  })
})

// =============================================================================
describe('admin/competenze — l\'audit registra la sede della CLASSE, non quella dell\'operatore', () => {
  it('POST su una sezione della seconda sede: la riga di audit porta SEDE_B', async () => {
    conPonte()
    const res = await COMP_POST(
      conCorpo('/api/admin/competenze', 'POST', { sectionId: SEZ_B, alunnoId: 'al-b' })
    )
    expect(res.status).toBe(200)
    const audit = h.db.audit_scritture_docente
    expect(audit).toHaveLength(1)
    expect(audit[0].scuola_id).toBe(SEDE_B)
    expect(audit[0].section_id).toBe(SEZ_B)
  })

  it('PATCH su un certificato della seconda sede: la riga di audit porta SEDE_B', async () => {
    conPonte()
    const res = await COMP_PATCH(
      conCorpo('/api/admin/competenze', 'PATCH', {
        certificatoId: CERT_B,
        livelli: [{ competenza_codice: 'C1', livello: 'A' }],
      })
    )
    expect(res.status).toBe(200)
    const audit = h.db.audit_scritture_docente
    expect(audit).toHaveLength(1)
    expect(audit[0].scuola_id).toBe(SEDE_B)
  })

  it('PATCH su un certificato di un plesso non proprio: 403 e il certificato resta com\'era', async () => {
    const res = await COMP_PATCH(
      conCorpo('/api/admin/competenze', 'PATCH', {
        certificatoId: CERT_B,
        livelli: [{ competenza_codice: 'C1', livello: 'A' }],
      })
    )
    expect(res.status).toBe(403)
    expect(scritte('certificato_competenza_livelli')).toHaveLength(0)
    expect(scritte('certificati_competenze')).toHaveLength(0)
    expect(h.db.certificati_competenze.find((c) => c.id === CERT_B)!.stato).toBe('bozza')
  })
})

// =============================================================================
describe('admin/primaria/materie — le tre scritture lasciate nude da PR #60', () => {
  it('POST su una sezione di un altro plesso: 403 e nessuna materia creata', async () => {
    const res = await MATERIE_POST(
      conCorpo('/api/admin/primaria/materie', 'POST', { sectionId: SEZ_B, nome: 'Storia', codice: 'STO' })
    )
    expect(res.status).toBe(403)
    expect(scritte('materie')).toHaveLength(0)
    expect(h.db.materie).toHaveLength(2)
  })

  it('POST ?action=apply-preset su una sezione di un altro plesso: 403 e nessun upsert', async () => {
    const res = await MATERIE_POST(
      conCorpo('/api/admin/primaria/materie?action=apply-preset', 'POST', { sectionId: SEZ_B, livello: 1 })
    )
    expect(res.status).toBe(403)
    expect(scritte('materie')).toHaveLength(0)
    expect(h.db.materie).toHaveLength(2)
  })

  it('POST sulla propria sezione: 201 e la materia nasce con la sede della sezione', async () => {
    const res = await MATERIE_POST(
      conCorpo('/api/admin/primaria/materie', 'POST', { sectionId: SEZ_A, nome: 'Storia', codice: 'STO' })
    )
    expect(res.status).toBe(201)
    const w = scritte('materie')
    expect(w).toHaveLength(1)
    expect(w[0].colpite[0].scuola_id).toBe(SEDE_A)
  })

  it('PATCH su una materia di un altro plesso: 403 e la riga resta intatta', async () => {
    const res = await MATERIE_PATCH(
      conCorpo('/api/admin/primaria/materie', 'PATCH', { id: MAT_B, nome: 'RINOMINATA' })
    )
    expect(res.status).toBe(403)
    expect(scritte('materie')).toHaveLength(0)
    expect(h.db.materie.find((m) => m.id === MAT_B)!.nome).toBe('Italiano')
  })

  it('DELETE su una materia di un altro plesso: 403 e la riga è ancora lì', async () => {
    const res = await MATERIE_DELETE(req(`/api/admin/primaria/materie?id=${MAT_B}`))
    expect(res.status).toBe(403)
    expect(scritte('materie')).toHaveLength(0)
    expect(h.db.materie.map((m) => m.id)).toContain(MAT_B)
  })

  it('DELETE sulla propria materia: 200 e la riga sparisce', async () => {
    const res = await MATERIE_DELETE(req(`/api/admin/primaria/materie?id=${MAT_A}`))
    expect(res.status).toBe(200)
    expect(h.db.materie.map((m) => m.id)).not.toContain(MAT_A)
  })
})

// =============================================================================
describe('admin/primaria/scrutinio-periodi — dal ponte utenti_scuole, non da utenti.scuola_id', () => {
  it('GET: i periodi della seconda sede NON compaiono a chi ha solo la prima', async () => {
    const res = await PERIODI_GET(req('/api/admin/primaria/scrutinio-periodi'))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.map((p: { nome: string }) => p.nome)).toEqual(['PERIODO-ALFA'])
  })

  it('GET: l\'admin col ponte vede anche i periodi della seconda sede', async () => {
    conPonte()
    const res = await PERIODI_GET(req('/api/admin/primaria/scrutinio-periodi'))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.map((p: { nome: string }) => p.nome).sort()).toEqual(['PERIODO-ALFA', 'PERIODO-BETA'])
  })

  it('GET ?scuolaId= della seconda sede: solo i periodi di quella', async () => {
    conPonte()
    const res = await PERIODI_GET(req(`/api/admin/primaria/scrutinio-periodi?scuolaId=${SEDE_B}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.map((p: { nome: string }) => p.nome)).toEqual(['PERIODO-BETA'])
  })

  it('GET ?scuolaId= di una sede NON accessibile: elenco vuoto, non i propri', async () => {
    const res = await PERIODI_GET(req(`/api/admin/primaria/scrutinio-periodi?scuolaId=${SEDE_B}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data).toEqual([])
  })

  it('POST: la sede dichiarata nel corpo è quella che finisce nella riga', async () => {
    conPonte()
    const res = await PERIODI_POST(
      conCorpo('/api/admin/primaria/scrutinio-periodi', 'POST', {
        scuolaId: SEDE_B,
        annoScolastico: '2025/2026',
        nome: 'NUOVO',
      })
    )
    expect(res.status).toBe(201)
    const w = scritte('scrutinio_periodi')
    expect(w).toHaveLength(1)
    expect(w[0].colpite[0].scuola_id).toBe(SEDE_B)
  })

  it('POST: sede ambigua e non dichiarata ⇒ 400 e nessuna riga scritta', async () => {
    conPonte()
    const res = await PERIODI_POST(
      conCorpo('/api/admin/primaria/scrutinio-periodi', 'POST', {
        annoScolastico: '2025/2026',
        nome: 'NUOVO',
      })
    )
    expect(res.status).toBe(400)
    expect(scritte('scrutinio_periodi')).toHaveLength(0)
    expect(h.db.scrutinio_periodi).toHaveLength(2)
  })

  it('PATCH su un periodo di un altro plesso: 404 e la riga resta com\'era', async () => {
    const res = await PERIODI_PATCH(
      conCorpo('/api/admin/primaria/scrutinio-periodi', 'PATCH', { id: PER_B, nome: 'RINOMINATO' })
    )
    expect(res.status).toBe(404)
    expect(h.db.scrutinio_periodi.find((p) => p.id === PER_B)!.nome).toBe('PERIODO-BETA')
  })

  it('DELETE su un periodo di un altro plesso: 404 e la riga è ancora lì', async () => {
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_B}`))
    expect(res.status).toBe(404)
    expect(h.db.scrutinio_periodi.map((p) => p.id)).toContain(PER_B)
  })

  it('DELETE sul proprio periodo: 200 e la riga sparisce', async () => {
    const res = await PERIODI_DELETE(req(`/api/admin/primaria/scrutinio-periodi?id=${PER_A}`))
    expect(res.status).toBe(200)
    expect(h.db.scrutinio_periodi.map((p) => p.id)).not.toContain(PER_A)
  })
})

// =============================================================================
describe('admin/primaria/obiettivi — PATCH e DELETE non agiscono più per solo id', () => {
  it('PATCH su un obiettivo di un altro plesso: 404 e la descrizione resta quella', async () => {
    const res = await OBIETTIVI_PATCH(
      conCorpo('/api/admin/primaria/obiettivi', 'PATCH', { id: OB_B, descrizione: 'RISCRITTO' })
    )
    expect(res.status).toBe(404)
    expect(h.db.obiettivi_apprendimento.find((o) => o.id === OB_B)!.descrizione).toBe('OBIETTIVO-BETA')
  })

  it('PATCH sul proprio obiettivo: 200 e la descrizione cambia', async () => {
    const res = await OBIETTIVI_PATCH(
      conCorpo('/api/admin/primaria/obiettivi', 'PATCH', { id: OB_A, descrizione: 'RISCRITTO' })
    )
    expect(res.status).toBe(200)
    expect(h.db.obiettivi_apprendimento.find((o) => o.id === OB_A)!.descrizione).toBe('RISCRITTO')
  })

  it('DELETE su un obiettivo di un altro plesso: 404 e la riga è ancora lì', async () => {
    const res = await OBIETTIVI_DELETE(req(`/api/admin/primaria/obiettivi?id=${OB_B}`))
    expect(res.status).toBe(404)
    expect(h.db.obiettivi_apprendimento.map((o) => o.id)).toContain(OB_B)
  })

  it('DELETE sul proprio obiettivo: 200 e la riga sparisce', async () => {
    const res = await OBIETTIVI_DELETE(req(`/api/admin/primaria/obiettivi?id=${OB_A}`))
    expect(res.status).toBe(200)
    expect(h.db.obiettivi_apprendimento.map((o) => o.id)).not.toContain(OB_A)
  })
})

// =============================================================================
describe('scope vuoto ⇒ NEGA (mai «allora eccoti tutto»)', () => {
  /** Cookie che seleziona una sede NON accessibile: l'intersezione è vuota. */
  const cookieAltroPlesso = `sedi_attive=${SEDE_B}`

  it('scrutinio-periodi GET: nessuna sede in scope ⇒ elenco vuoto, non l\'elenco intero', async () => {
    const res = await PERIODI_GET(req('/api/admin/primaria/scrutinio-periodi', cookieAltroPlesso))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data).toEqual([])
  })

  it('obiettivi DELETE: nessuna sede in scope ⇒ 404 e la riga della propria sede resta', async () => {
    const res = await OBIETTIVI_DELETE(
      req(`/api/admin/primaria/obiettivi?id=${OB_A}`, cookieAltroPlesso)
    )
    expect(res.status).toBe(404)
    expect(h.db.obiettivi_apprendimento.map((o) => o.id)).toContain(OB_A)
  })
})

// =============================================================================
describe('admin/primaria/docente-gradi — non si riclassifica il personale di un\'altra sede', () => {
  it('PATCH su un docente di un altro plesso: 403 e i suoi gradi restano quelli', async () => {
    const res = await GRADI_PATCH(
      conCorpo('/api/admin/primaria/docente-gradi', 'PATCH', { utenteId: DOC_B, gradi: ['primaria'] })
    )
    expect(res.status).toBe(403)
    expect(scritte('utenti')).toHaveLength(0)
    expect(h.db.utenti.find((u) => u.id === DOC_B)!.gradi).toEqual(['infanzia'])
  })

  it('PATCH su un docente del proprio plesso: 200 e i gradi cambiano', async () => {
    const res = await GRADI_PATCH(
      conCorpo('/api/admin/primaria/docente-gradi', 'PATCH', { utenteId: DOC_A, gradi: ['primaria'] })
    )
    expect(res.status).toBe(200)
    expect(h.db.utenti.find((u) => u.id === DOC_A)!.gradi).toEqual(['primaria'])
  })
})
