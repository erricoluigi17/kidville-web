import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import {
  SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B, SEDE_E2E, NOME_SEDE_E2E,
} from '../fixtures/sedi'

// =============================================================================
// Modulistica — le MUTAZIONI, che l'audit del 30/07 aveva lasciato scoperte.
//
// PR #60 aveva chiuso le LETTURE di elenchi, graduatorie ed export. Restavano
// nude tutte le scritture dello stesso modulo: `forms/delibera` decide ammessi e
// lista d'attesa su domande di qualunque plesso, `admin/forms` modifica e
// cancella i template altrui per solo id, `admin/form-models` PATCH usa
// `.loose()` e lascia riscrivere `scuola_id` — cioè la chiave di tenancy stessa —
// oltre a `public_token`, `published_at` e `is_enrollment_form`.
//
// Qui il finto client FILTRA e SCRIVE davvero: ogni caso asserisce lo stato
// esatto della risposta E lo stato del database (o l'accumulatore `scritture`).
// Mai `not.toBe(403)`: è la forma dei falsi verdi trovati il 30/07.
//
// Il modello con `scuola_id NULL` è GLOBALE: si legge da tutte le sedi, si
// modifica solo da chi ha in scope tutte le sedi reali (la Direzione).
// =============================================================================

const SUB_A = '11111111-1111-4111-8111-11111111111a'
const SUB_B = '22222222-2222-4222-8222-22222222222b'
const MODELLO_A = '33333333-3333-4333-8333-33333333333a'
const MODELLO_B = '44444444-4444-4444-8444-44444444444b'
const MODELLO_GLOBALE = '55555555-5555-4555-8555-555555555550'
const TEMPLATE_A = '66666666-6666-4666-8666-66666666666a'
const TEMPLATE_B = '77777777-7777-4777-8777-77777777777b'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  logScrittura: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
  requireUser: h.requireStaff,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { POST as DELIBERA } from '@/app/api/forms/delibera/route'
import { GET as DELIBERA_PDF } from '@/app/api/forms/export/delibera/route'
import { PATCH as SUBMISSION_PATCH } from '@/app/api/admin/forms/submissions/[id]/route'
import { PATCH as TEMPLATE_PATCH, DELETE as TEMPLATE_DELETE } from '@/app/api/admin/forms/route'
import { PATCH as MODELLO_PATCH } from '@/app/api/admin/form-models/route'
import { POST as MODELLO_PUBLISH } from '@/app/api/admin/form-models/publish/route'
import { GET as MODELLO_GET } from '@/app/api/admin/form-models/[id]/route'
import { GET as MODELLI_LISTA } from '@/app/api/admin/forms/models/route'

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, init as never)
const conCorpo = (metodo: string, corpo: unknown) =>
  req('/api/x', { method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const riga = (tabella: string, id: string) =>
  (h.db[tabella] ?? []).find((r) => r.id === id) as Record<string, unknown> | undefined

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
  utenti_scuole: [],
  form_submissions: [
    {
      id: SUB_A, model_id: MODELLO_A, scuola_id: SEDE_A, status: 'completed', score: 10,
      created_at: '2026-07-30T10:00:00Z', data: { cognome_alunno: 'ROSSIALFA', nome_alunno: 'Aldo' },
    },
    {
      id: SUB_B, model_id: MODELLO_A, scuola_id: SEDE_B, status: 'completed', score: 20,
      created_at: '2026-07-30T11:00:00Z', data: { cognome_alunno: 'BIANCHIBETA', nome_alunno: 'Bea' },
    },
  ],
  form_models: [
    // `requires_signature` è `NOT NULL DEFAULT false` sulla tabella vera: qui c'è perché
    // una riga di prova senza una colonna obbligatoria fa passare per «campo non esposto»
    // ciò che è solo «campo non scritto nel finto».
    { id: MODELLO_A, title: 'Modello della sede A', scuola_id: SEDE_A, public_token: 'tok-a', published_at: null, access_mode: 'public', is_enrollment_form: false, requires_signature: true },
    { id: MODELLO_B, title: 'Modello della sede B', scuola_id: SEDE_B, public_token: 'tok-b', published_at: null, access_mode: 'public', is_enrollment_form: false, requires_signature: false },
    { id: MODELLO_GLOBALE, title: 'Modello globale', scuola_id: null, public_token: 'tok-glob', published_at: '2026-07-01T00:00:00Z', access_mode: 'public', is_enrollment_form: true, requires_signature: false },
  ],
  forms_templates: [
    { id: TEMPLATE_A, scuola_id: SEDE_A, title: 'Autorizzazione A', created_at: '2026-07-01T00:00:00Z' },
    { id: TEMPLATE_B, scuola_id: SEDE_B, title: 'Autorizzazione B', created_at: '2026-07-02T00:00:00Z' },
  ],
})

const SEGRETERIA_A = { id: 'seg-a', role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_A }
const DIREZIONE_TUTTE = { id: 'dir', role: 'admin', ruolo: 'admin', scuola_id: SEDE_A }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: SEGRETERIA_A })
  h.requireDocente.mockResolvedValue({ user: SEGRETERIA_A })
})

/** La Direzione multi-plesso: tutte le sedi REALI nel ponte `utenti_scuole`. */
function conDirezioneSuTutteLeSedi() {
  h.db.utenti_scuole = [
    { utente_id: DIREZIONE_TUTTE.id, scuola_id: SEDE_A },
    { utente_id: DIREZIONE_TUTTE.id, scuola_id: SEDE_B },
  ]
  h.requireStaff.mockResolvedValue({ user: DIREZIONE_TUTTE })
  h.requireDocente.mockResolvedValue({ user: DIREZIONE_TUTTE })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/forms/delibera — la decisione di ammissione resta nella sede', () => {
  it('bulk: delibera SOLO le domande della propria sede', async () => {
    const res = await DELIBERA(conCorpo('POST', { modelId: MODELLO_A, posti: 1, soglia: 0 }))
    expect(res.status).toBe(200)
    // Stato del database, non solo della risposta.
    expect(riga('form_submissions', SUB_A)?.esito_ammissione).toBe('ammesso')
    expect(riga('form_submissions', SUB_B)?.esito_ammissione).toBeUndefined()
    // Senza filtro la domanda dell'altra sede avrebbe il punteggio più alto e si
    // sarebbe presa l'unico posto: il conteggio lo dimostra.
    expect((await res.json()).data.totale).toBe(1)
  })

  it('override su una domanda di un\'altra sede: 404 e nessuna scrittura', async () => {
    const res = await DELIBERA(conCorpo('POST', { submissionId: SUB_B, esito: 'ammesso' }))
    expect(res.status).toBe(404)
    expect(riga('form_submissions', SUB_B)?.esito_ammissione).toBeUndefined()
    expect(scrittureSu('form_submissions')).toHaveLength(0)
  })

  it('override sulla propria sede: 200 e l\'esito è scritto', async () => {
    const res = await DELIBERA(conCorpo('POST', { submissionId: SUB_A, esito: 'lista_attesa' }))
    expect(res.status).toBe(200)
    expect(riga('form_submissions', SUB_A)?.esito_ammissione).toBe('lista_attesa')
    expect(riga('form_submissions', SUB_A)?.esito_da).toBe('seg-a')
  })

  it('scope vuoto: nega, non delibera tutto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'orfano', role: 'segreteria', scuola_id: null } })
    const res = await DELIBERA(conCorpo('POST', { modelId: MODELLO_A, posti: 5, soglia: 0 }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.totale).toBe(0)
    expect(riga('form_submissions', SUB_A)?.esito_ammissione).toBeUndefined()
    expect(riga('form_submissions', SUB_B)?.esito_ammissione).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/forms/export/delibera — il PDF di graduatoria', () => {
  it('non stampa i minori dell\'altra sede', async () => {
    const res = await DELIBERA_PDF(req(`/api/forms/export/delibera?modelId=${MODELLO_A}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1')
    expect(pdf).toContain('ROSSIALFA')
    expect(pdf).not.toContain('BIANCHIBETA')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/forms/submissions/[id] — punteggio e presa in carico', () => {
  it('domanda di un\'altra sede: 404 (non 403: non è un oracolo di esistenza) e riga intatta', async () => {
    const res = await SUBMISSION_PATCH(conCorpo('PATCH', { gestita: true }), ctx(SUB_B))
    expect(res.status).toBe(404)
    expect(riga('form_submissions', SUB_B)?.gestita_il).toBeUndefined()
    expect(scrittureSu('form_submissions')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('domanda della propria sede: 200 e gestita_il derivato dal server', async () => {
    const res = await SUBMISSION_PATCH(conCorpo('PATCH', { gestita: true }), ctx(SUB_A))
    expect(res.status).toBe(200)
    expect(typeof riga('form_submissions', SUB_A)?.gestita_il).toBe('string')
    expect(riga('form_submissions', SUB_A)?.gestita_da).toBe('seg-a')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH e DELETE /api/admin/forms — i template di modulistica', () => {
  it('PATCH di un template di un\'altra sede: 404 e titolo invariato', async () => {
    const res = await TEMPLATE_PATCH(conCorpo('PATCH', { id: TEMPLATE_B, title: 'DIROTTATO' }))
    expect(res.status).toBe(404)
    expect(riga('forms_templates', TEMPLATE_B)?.title).toBe('Autorizzazione B')
  })

  it('PATCH del proprio template: 200 e titolo aggiornato', async () => {
    const res = await TEMPLATE_PATCH(conCorpo('PATCH', { id: TEMPLATE_A, title: 'Aggiornato' }))
    expect(res.status).toBe(200)
    expect(riga('forms_templates', TEMPLATE_A)?.title).toBe('Aggiornato')
  })

  it('DELETE di un template di un\'altra sede: 404 e la riga è ancora lì', async () => {
    const res = await TEMPLATE_DELETE(conCorpo('DELETE', { id: TEMPLATE_B }))
    expect(res.status).toBe(404)
    expect(riga('forms_templates', TEMPLATE_B)).toBeDefined()
  })

  it('DELETE del proprio template: 200 e la riga sparisce', async () => {
    const res = await TEMPLATE_DELETE(conCorpo('DELETE', { id: TEMPLATE_A }))
    expect(res.status).toBe(200)
    expect(riga('forms_templates', TEMPLATE_A)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/form-models — via `.loose()`, allowlist esplicita', () => {
  it('`scuola_id` nel body NON è scrivibile: la chiave di tenancy non si riscrive dal client', async () => {
    const res = await MODELLO_PATCH(conCorpo('PATCH', {
      id: MODELLO_A, title: 'Rinominato', scuola_id: SEDE_B,
      public_token: 'token-scelto-dal-client', published_at: '2020-01-01T00:00:00Z',
      is_enrollment_form: true,
    }))
    expect(res.status).toBe(200)
    expect(riga('form_models', MODELLO_A)?.title).toBe('Rinominato')
    // Il database: la sede è quella di prima, il token pure, e il modello NON è
    // diventato il modulo d'iscrizione.
    expect(riga('form_models', MODELLO_A)?.scuola_id).toBe(SEDE_A)
    expect(riga('form_models', MODELLO_A)?.public_token).toBe('tok-a')
    expect(riga('form_models', MODELLO_A)?.published_at).toBeNull()
    expect(riga('form_models', MODELLO_A)?.is_enrollment_form).toBe(false)
    // E l'accumulatore: quelle colonne non sono nemmeno state proposte all'UPDATE.
    const patch = scrittureSu('form_models').at(-1)?.valori[0] ?? {}
    expect(Object.keys(patch)).not.toContain('scuola_id')
    expect(Object.keys(patch)).not.toContain('public_token')
    expect(Object.keys(patch)).not.toContain('published_at')
    expect(Object.keys(patch)).not.toContain('is_enrollment_form')
  })

  it('modello di un\'altra sede: 404 e titolo invariato', async () => {
    const res = await MODELLO_PATCH(conCorpo('PATCH', { id: MODELLO_B, title: 'DIROTTATO' }))
    expect(res.status).toBe(404)
    expect(riga('form_models', MODELLO_B)?.title).toBe('Modello della sede B')
    expect(scrittureSu('form_models')).toHaveLength(0)
  })

  it('modello GLOBALE da chi ha una sola sede: 403 — vale per tutte, si modifica da chi le ha tutte', async () => {
    const res = await MODELLO_PATCH(conCorpo('PATCH', { id: MODELLO_GLOBALE, title: 'DIROTTATO' }))
    expect(res.status).toBe(403)
    expect(riga('form_models', MODELLO_GLOBALE)?.title).toBe('Modello globale')
    expect(scrittureSu('form_models')).toHaveLength(0)
  })

  it('modello GLOBALE dalla Direzione con tutte le sedi reali: 200', async () => {
    conDirezioneSuTutteLeSedi()
    const res = await MODELLO_PATCH(conCorpo('PATCH', { id: MODELLO_GLOBALE, title: 'Rinominato' }))
    expect(res.status).toBe(200)
    expect(riga('form_models', MODELLO_GLOBALE)?.title).toBe('Rinominato')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/form-models/publish — il link pubblico', () => {
  it('modello di un\'altra sede: 404 e nessun token generato', async () => {
    const res = await MODELLO_PUBLISH(conCorpo('POST', { id: MODELLO_B, action: 'publish' }))
    expect(res.status).toBe(404)
    expect(riga('form_models', MODELLO_B)?.published_at).toBeNull()
    expect(scrittureSu('form_models')).toHaveLength(0)
  })

  it('RITIRO di un modello globale da chi ha una sola sede: 403 e il link resta attivo', async () => {
    const res = await MODELLO_PUBLISH(conCorpo('POST', { id: MODELLO_GLOBALE, action: 'unpublish' }))
    expect(res.status).toBe(403)
    expect(riga('form_models', MODELLO_GLOBALE)?.published_at).toBe('2026-07-01T00:00:00Z')
  })

  it('modello della propria sede: 200, token e published_at scritti', async () => {
    const res = await MODELLO_PUBLISH(conCorpo('POST', { id: MODELLO_A, action: 'publish' }))
    expect(res.status).toBe(200)
    expect((await res.json()).public_token).toBe('tok-a')
    expect(typeof riga('form_models', MODELLO_A)?.published_at).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/form-models/[id] — lettura del modello per il builder', () => {
  it('modello di un\'altra sede: 404', async () => {
    const res = await MODELLO_GET(req('/api/admin/form-models/x'), ctx(MODELLO_B))
    expect(res.status).toBe(404)
  })

  it('modello globale: 200 — le righe globali si LEGGONO da tutte le sedi', async () => {
    const res = await MODELLO_GET(req('/api/admin/form-models/x'), ctx(MODELLO_GLOBALE))
    expect(res.status).toBe(200)
    expect((await res.json()).title).toBe('Modello globale')
  })

  it('modello della propria sede: 200', async () => {
    const res = await MODELLO_GET(req('/api/admin/form-models/x'), ctx(MODELLO_A))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/forms/models — elenco per i filtri admin', () => {
  it('elenca i modelli propri e quelli globali, mai quelli di un\'altra sede', async () => {
    const res = await MODELLI_LISTA(req('/api/admin/forms/models'))
    expect(res.status).toBe(200)
    const titoli = ((await res.json()) as { title: string }[]).map((m) => m.title)
    expect(titoli).toContain('Modello della sede A')
    expect(titoli).toContain('Modello globale')
    expect(titoli).not.toContain('Modello della sede B')
  })

  it('non distribuisce `public_token`: è la capability che apre /m/{token} senza credenziali', async () => {
    const res = await MODELLI_LISTA(req('/api/admin/forms/models'))
    const corpo = await res.text()
    expect(corpo).not.toContain('public_token')
    expect(corpo).not.toContain('tok-glob')
  })

  /**
   * `scuola_id` e `requires_signature` ESCONO, ed è la barra filtri della linguetta a
   * chiederli: «solo quelli che chiedono la firma» e «solo quelli di questo plesso» sono due
   * criteri che, senza questi campi, la schermata avrebbe dovuto o indovinare o andarsi a
   * leggere una seconda volta. Sono un booleano e l'uuid di una sede che chi guarda ha già
   * nel proprio contesto: nessuno dei due apre niente, a differenza di `public_token`.
   */
  it('distribuisce `scuola_id` e `requires_signature`: sono i due assi su cui la segreteria filtra', async () => {
    const res = await MODELLI_LISTA(req('/api/admin/forms/models'))
    const righe = (await res.json()) as Record<string, unknown>[]
    const globale = righe.find((m) => m.title === 'Modello globale')
    const dellaSede = righe.find((m) => m.title === 'Modello della sede A')
    // `scuola_id` NULL è il dato, non l'assenza del dato: dice «vale per tutte le sedi», e
    // la chiave deve esserci per poterlo distinguere da un campo che non è stato letto.
    expect(globale).toHaveProperty('scuola_id')
    expect(globale?.scuola_id).toBeNull()
    expect(dellaSede?.scuola_id).toBe(SEDE_A)
    expect(righe.every((m) => 'requires_signature' in m)).toBe(true)
  })
})
