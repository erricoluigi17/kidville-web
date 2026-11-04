import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// S-1 · LA COMPILAZIONE A NOME DI UN ALTRO.
//
// Fino al 31/10 `POST /api/forms/submit` prendeva `userId` dal CORPO e non
// guardava mai la sessione: service-role, nessun gate. Chiunque — anche senza
// account — poteva far nascere in `form_submissions` una compilazione
// `completed` intestata a qualunque genitore. E con lo stesso `userId` falso
// decideva due cose che non sono sue: se il genitore è sospeso per morosità
// (si dichiarava un genitore in regola) e in quale sede finisce la riga (si
// dichiarava un genitore di un'altra sede).
//
// La regola che questi test bloccano: **l'intestatario è la sessione**. Un
// `userId` nel corpo è ammesso solo se coincide; diverso → 403, prima di
// qualunque lettura. È la stessa regola di `forms/send-otp:POST`.
//
// Il modulo DAVVERO pubblico (link `/m/<token>`) non passa da qui: ha la sua
// route, anonima, che scrive `user_id: null` e non accetta identità dal corpo.
// L'ultimo blocco la tiene ferma così.
// =============================================================================

const MODELLO = '55555555-5555-4555-8555-555555555550'
const GENITORE = '99999999-9999-4999-8999-99999999999a'
const ALTRO_GENITORE = '77777777-7777-4777-8777-77777777777b'
const SEGRETERIA = '66666666-6666-4666-8666-666666666666'
const TOKEN = 'a0000000-0000-4000-8000-00000000a10b'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  /** L'identità di SESSIONE: `null` = anonimo, nessun cookie. */
  chiamante: null as { id: string; role: string } | null,
  /** Per chi è stata chiesta la verifica di sospensione. */
  sospensioneChiestaPer: [] as string[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () =>
    h.chiamante
      ? { user: { id: h.chiamante.id, role: h.chiamante.role, scuola_id: null } }
      : { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
  ),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '127.0.0.1',
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospesoSalvoEssenziale: async (_sb: unknown, id: string) => {
    h.sospensioneChiestaPer.push(id)
    return null
  },
}))
vi.mock('@/lib/forms/sempre-firmabile', () => ({ leggiSempreFirmabile: async () => false }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [] }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: vi.fn((evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    }),
  }
})

import { POST as SUBMIT } from '@/app/api/forms/submit/route'
import { POST as SUBMIT_PUBBLICO } from '@/app/api/public/forms/[token]/submit/route'

const corpo = (payload: unknown) =>
  new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

const compilazioni = () => h.db.form_submissions ?? []
const letturaUtentiPer = () =>
  h.tabelle.filter((t) => t === 'utenti').length

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti: [
      { id: GENITORE, scuola_id: SEDE_A, ruolo: 'genitore' },
      { id: ALTRO_GENITORE, scuola_id: SEDE_B, ruolo: 'genitore' },
      { id: SEGRETERIA, scuola_id: SEDE_A, ruolo: 'segreteria' },
    ],
    form_models: [{
      id: MODELLO, title: 'Modello globale', scuola_id: null, schema: { pages: [] },
      public_token: TOKEN, published_at: '2026-07-01T00:00:00Z', access_mode: 'public',
    }],
    form_submissions: [],
  }
  h.tabelle = []
  h.scritture = []
  h.chiamante = null
  h.sospensioneChiestaPer = []
  h.eventi = []
})

describe('POST /api/forms/submit — l\'intestatario è la sessione, non il corpo', () => {
  it('userId di un ALTRO genitore → 403, nessuna riga, nessuna lettura a suo nome', async () => {
    h.chiamante = { id: GENITORE, role: 'genitore' }
    const res = await SUBMIT(corpo({ modelId: MODELLO, userId: ALTRO_GENITORE, data: { a: 1 } }))

    expect(res.status).toBe(403)
    expect(compilazioni()).toHaveLength(0)
    expect(h.scritture.filter((s) => s.tabella === 'form_submissions')).toHaveLength(0)
    // Il `userId` dichiarato non decide più niente: né la sospensione né la sede.
    expect(h.sospensioneChiestaPer).not.toContain(ALTRO_GENITORE)
    expect(letturaUtentiPer()).toBe(0)
  })

  it('il rifiuto si registra a `warn` con soli uuid e ruolo', async () => {
    h.chiamante = { id: GENITORE, role: 'genitore' }
    await SUBMIT(corpo({ modelId: MODELLO, userId: ALTRO_GENITORE, data: { a: 1 } }))

    const rifiuto = h.eventi.find((e) => e.campi.esito === 'intestatario-non-proprio')
    expect(rifiuto).toBeDefined()
    expect(rifiuto!.evento).toBe('modulistica')
    expect(rifiuto!.livello).toBe('warn')
    expect(rifiuto!.campi).toEqual({
      operazione: 'forms/submit:POST',
      esito: 'intestatario-non-proprio',
      utente: GENITORE,
      ruolo: 'genitore',
    })
  })

  it('anche la segreteria non intesta a un genitore da qui: 403', async () => {
    h.chiamante = { id: SEGRETERIA, role: 'segreteria' }
    const res = await SUBMIT(corpo({ modelId: MODELLO, userId: ALTRO_GENITORE, data: { a: 1 } }))
    expect(res.status).toBe(403)
    expect(compilazioni()).toHaveLength(0)
  })

  it('anonimo → 401, nessuna riga (prima: 201 con user_id null)', async () => {
    const res = await SUBMIT(corpo({ modelId: MODELLO, data: { a: 1 } }))
    expect(res.status).toBe(401)
    expect(compilazioni()).toHaveLength(0)
  })

  it('anonimo che dichiara un userId → 401, mai una riga a nome di quel genitore', async () => {
    const res = await SUBMIT(corpo({ modelId: MODELLO, userId: ALTRO_GENITORE, data: { a: 1 } }))
    expect(res.status).toBe(401)
    expect(compilazioni()).toHaveLength(0)
    expect(h.sospensioneChiestaPer).toHaveLength(0)
  })

  it('userId uguale alla sessione → 201 intestata a lui, sede e sospensione sue', async () => {
    h.chiamante = { id: GENITORE, role: 'genitore' }
    const res = await SUBMIT(corpo({ modelId: MODELLO, userId: GENITORE, data: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(compilazioni()).toHaveLength(1)
    expect(compilazioni()[0].user_id).toBe(GENITORE)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_A)
    expect(h.sospensioneChiestaPer).toEqual([GENITORE])
  })

  it('senza userId nel corpo → 201 intestata alla sessione (non più a nessuno)', async () => {
    h.chiamante = { id: GENITORE, role: 'genitore' }
    const res = await SUBMIT(corpo({ modelId: MODELLO, data: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(compilazioni()[0].user_id).toBe(GENITORE)
    expect(compilazioni()[0].scuola_id).toBe(SEDE_A)
    // Prima, ometterlo saltava del tutto il controllo di sospensione.
    expect(h.sospensioneChiestaPer).toEqual([GENITORE])
  })
})

describe('POST /api/public/forms/[token]/submit — il modulo pubblico resta anonimo', () => {
  it('201 senza sessione, `user_id` null anche se il corpo dichiara un genitore', async () => {
    // Una sola sede reale: il modello globale ne prende una senza ambiguità.
    h.db.scuole = [{ id: SEDE_A, attiva: true }]
    h.db.schools = [{ id: SEDE_A, nome: NOME_SEDE_A }]
    const res = await SUBMIT_PUBBLICO(
      corpo({ data: { a: 1 }, userId: ALTRO_GENITORE }),
      { params: Promise.resolve({ token: TOKEN }) },
    )
    expect(res.status).toBe(201)
    expect(compilazioni()).toHaveLength(1)
    expect(compilazioni()[0].user_id).toBeNull()
    expect(h.sospensioneChiestaPer).toHaveLength(0)
  })
})
