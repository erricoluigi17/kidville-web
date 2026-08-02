import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B, SEDE_E2E, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// `form_submissions.scuola_id`: UNA semantica, e non è mai NULL.
//
// Il difetto (audit 2026-07-31, R25): NULL significava «tutte le sedi» in
// scrittura e «nessuna sede» in lettura. I quattro lettori corretti da PR #60
// filtrano con `.in('scuola_id', plessi)`, e in SQL `NULL IN (…)` vale NULL —
// non true: una compilazione senza sede non la vedeva PIÙ NESSUNO, nemmeno la
// Direzione. Il commento nel codice affermava l'opposto («la riga è visibile
// alla sola Direzione, che è la risposta onesta»), ed è il tipo di commento che
// impedisce a chi indaga di sospettare.
//
// La decisione: la sede si risolve — chi compila → il modello → l'unica sede
// reale — e se resta ambigua l'invio si RIFIUTA (400). Inventarle una sede
// sarebbe peggio; scriverla NULL è perderla in silenzio.
// =============================================================================

const MODELLO_GLOBALE = '55555555-5555-4555-8555-555555555550'
const MODELLO_DI_SEDE_B = '44444444-4444-4444-8444-44444444444b'
const GENITORE_CON_SEDE = '99999999-9999-4999-8999-99999999999a'
const GENITORE_SENZA_SEDE = '88888888-8888-4888-8888-888888888880'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  notifica: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
// Il limitatore è a stato di modulo: qui non è l'oggetto del test e renderebbe
// l'esito dipendente dall'ordine dei casi.
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '127.0.0.1',
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospesoSalvoEssenziale: async () => null,
}))
vi.mock('@/lib/forms/sempre-firmabile', () => ({ leggiSempreFirmabile: async () => false }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notifica }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [] }))

import { POST as SUBMIT } from '@/app/api/forms/submit/route'
import { POST as SUBMIT_PUBBLICO } from '@/app/api/public/forms/[token]/submit/route'

const corpo = (payload: unknown) =>
  new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
// I TOKEN SONO UUID, e questi test usavano `'tok-glob'`/`'tok-b'`. Non era un dettaglio di
// comodo: `form_models.public_token` è di tipo `uuid`, quindi in produzione una stringa così
// non fa «nessuna riga» — fa rispondere a Postgres `22P02`, che è un ALTRO ramo di codice.
// Con un doppio che risponde `{ data: null }` a qualunque valore, quel ramo non si vedeva:
// il 2026-08-02 `POST /api/public/forms/non-un-uuid/submit` rispondeva 500 col gate verde.
const TOKEN_GLOBALE = 'a0000000-0000-4000-8000-00000000a10b'
const TOKEN_SEDE_B = 'b0000000-0000-4000-8000-0000000000b0'
const ctxToken = (token: string) => ({ params: Promise.resolve({ token }) })

const compilazioni = () => h.db.form_submissions ?? []
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
  utenti: [
    { id: GENITORE_CON_SEDE, scuola_id: SEDE_A, ruolo: 'genitore' },
    { id: GENITORE_SENZA_SEDE, scuola_id: null, ruolo: 'genitore' },
  ],
  form_models: [
    {
      id: MODELLO_GLOBALE, title: 'Modello globale', scuola_id: null, schema: { pages: [] },
      public_token: TOKEN_GLOBALE, published_at: '2026-07-01T00:00:00Z', access_mode: 'public',
    },
    {
      id: MODELLO_DI_SEDE_B, title: 'Modello della sede B', scuola_id: SEDE_B, schema: { pages: [] },
      public_token: TOKEN_SEDE_B, published_at: '2026-07-01T00:00:00Z', access_mode: 'public',
    },
  ],
  form_submissions: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/forms/submit — la compilazione di un genitore nasce con una sede', () => {
  it('la sede di chi compila vince: 201 e la riga la porta scritta', async () => {
    const res = await SUBMIT(corpo({ modelId: MODELLO_GLOBALE, userId: GENITORE_CON_SEDE, data: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(compilazioni()).toHaveLength(1)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_A)
    expect(scrittureSu('form_submissions')[0].valori[0].scuola_id).toBe(SEDE_A)
  })

  it('sede non risolvibile e due sedi reali: 400 e NESSUNA riga orfana', async () => {
    const res = await SUBMIT(corpo({ modelId: MODELLO_GLOBALE, userId: GENITORE_SENZA_SEDE, data: { a: 1 } }))
    expect(res.status).toBe(400)
    expect(compilazioni()).toHaveLength(0)
    expect(scrittureSu('form_submissions')).toHaveLength(0)
  })

  it('chi compila non ha sede ma il modello sì: 201 con la sede del modello', async () => {
    const res = await SUBMIT(corpo({ modelId: MODELLO_DI_SEDE_B, userId: GENITORE_SENZA_SEDE, data: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_B)
  })

  it('una sola sede reale (la sede E2E non conta): si usa quella, nessun 400', async () => {
    h.db.schools = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_E2E, nome: NOME_SEDE_E2E }]
    h.db.scuole = [{ id: SEDE_A, attiva: true }]
    const res = await SUBMIT(corpo({ modelId: MODELLO_GLOBALE, userId: GENITORE_SENZA_SEDE, data: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/public/forms/[token]/submit — l\'invio anonimo da link pubblico', () => {
  it('modello di una sede: 201 e la riga porta quella sede', async () => {
    const res = await SUBMIT_PUBBLICO(corpo({ data: { a: 1 } }), ctxToken(TOKEN_SEDE_B))
    expect(res.status).toBe(201)
    expect(compilazioni()).toHaveLength(1)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_B)
  })

  it('modello globale con due sedi reali: 400 — mai una compilazione che non vedrà nessuno', async () => {
    const res = await SUBMIT_PUBBLICO(corpo({ data: { a: 1 } }), ctxToken(TOKEN_GLOBALE))
    expect(res.status).toBe(400)
    expect(compilazioni()).toHaveLength(0)
    expect(scrittureSu('form_submissions')).toHaveLength(0)
  })

  it('una sola sede reale: l\'invio anonimo passa e prende quella sede', async () => {
    h.db.schools = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_E2E, nome: NOME_SEDE_E2E }]
    h.db.scuole = [{ id: SEDE_A, attiva: true }]
    const res = await SUBMIT_PUBBLICO(corpo({ data: { a: 1 } }), ctxToken(TOKEN_GLOBALE))
    expect(res.status).toBe(201)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_A)
  })
})
