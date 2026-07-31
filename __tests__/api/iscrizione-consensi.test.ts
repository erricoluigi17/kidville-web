import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// =============================================================================
// Informativa e prova dei consensi sul modulo pubblico d'iscrizione.
//
// Il modulo raccoglie allergie, note mediche (BES, DSA, patologie) e il
// documento d'identità del MINORE. Fino al 2026-07-31 lo faceva senza mostrare
// alcuna informativa e senza registrare niente: non mancava un filtro, mancava
// proprio il posto dove scrivere la prova.
//
// Due proprietà, e la seconda conta quanto la prima:
//  1. senza la presa visione dell'informativa l'invio è RESPINTO — e la verifica
//     sta sul SERVER, perché un invio fatto fuori dal wizard non esegue il
//     codice del wizard;
//  2. NON si chiede il consenso per i dati sanitari. Un consenso che non si può
//     rifiutare — senza l'allergia la Scuola non può preparare il pasto in
//     sicurezza — non è libero, e un consenso non libero non è una base
//     giuridica: si tratterebbero dati sanitari di minori credendo di averne una.
//     Il consenso resta sulle FOTO, dove rifiutare non costa nulla al bambino,
//     ed è granulare per canale.
// =============================================================================

const SEDE = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
}))

// Modello minimale: un solo campo per bambino/adulto. Qui si prova il consenso,
// non la validazione dei campi, che ha i suoi test.
const minimalModel = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
      { id: 'adulto', title: 'A', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
    ],
  },
}

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.7',
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      if (table === 'schools' || table === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: SEDE, nome: 'Kidville Giugliano', attiva: true }], error: null }).then(res)
        return b
      }
      if (table === 'form_models') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: minimalModel, error: null })
        return b
      }
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.select = () => b
      b.single = async () => ({ data: { id: 'sub-1' }, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn(async () => []),
  scuolaUnicaReale: vi.fn(async () => SEDE),
}))

import { POST } from '@/app/api/iscrizione/route'
import { CONSENSI_FIELDS } from '@/lib/forms/enrollment-template'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'

const invia = (data: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ scuola_id: SEDE, data }),
    }),
  )

const famiglia = (extra: Record<string, unknown> = {}) => ({
  children: [{ nome: 'Tino', cognome: 'Prova' }],
  adults: [{ nome: 'Ines', cognome: 'Prova' }],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
})

describe('il modulo NON chiede il consenso per i dati sanitari', () => {
  it('nessun blocco obbligatorio riguarda allergie, salute o dati sanitari', () => {
    const obbligatori = CONSENSI_FIELDS.filter((f) => f.required)
    expect(obbligatori).toHaveLength(1)
    expect(obbligatori[0].id).toBe('presa_visione_informativa')
    for (const f of CONSENSI_FIELDS) {
      const testo = `${f.id} ${f.label} ${f.text ?? ''}`.toLowerCase()
      const chiedeConsensoSanitario =
        /acconsento/.test(testo) && /(allergi|salute|sanitar|medic|patologi)/.test(testo)
      expect(chiedeConsensoSanitario, `«${f.label}» chiede un consenso sui dati sanitari`).toBe(false)
    }
  })

  it('il consenso foto è granulare per canale e sempre facoltativo', () => {
    const foto = CONSENSI_FIELDS.filter((f) => f.id.startsWith('consenso_foto_'))
    // Galleria riservata, sito e social sono ambiti diversi: un consenso
    // raccolto per l'uno non copre gli altri (provv. Garante 725/2025).
    expect(foto.map((f) => f.id).sort()).toEqual([
      'consenso_foto_galleria',
      'consenso_foto_sito',
      'consenso_foto_social',
    ])
    for (const f of foto) expect(f.required).toBeFalsy()
  })
})

describe('POST /api/iscrizione — la presa visione è verificata sul SERVER', () => {
  it('senza presa visione: 400, e NIENTE viene scritto', async () => {
    const res = await invia(famiglia())
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.consensi).toContain('presa_visione_informativa')
    expect(h.inserts).toHaveLength(0)
  })

  it('presa visione a `false` non vale come accettazione', async () => {
    const res = await invia(famiglia({ presa_visione_informativa: false }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('con la presa visione: 201 e la prova viene registrata', async () => {
    const res = await invia(famiglia({ presa_visione_informativa: true }))
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    const log = h.inserts[0].consents_log as Record<string, unknown>
    expect(log).toBeTruthy()
    expect(log.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(log.ip).toBe('203.0.113.7')
    const blocchi = log.blocchi as { field_id: string; accepted: boolean; text?: string }[]
    const presa = blocchi.find((b) => b.field_id === 'presa_visione_informativa')
    expect(presa?.accepted).toBe(true)
    // La prova deve dire COSA è stato accettato, non solo che qualcosa lo è
    // stato: il testo mostrato viene congelato dentro la riga.
    expect(presa?.text).toBeTruthy()
  })

  it('la versione NON è spoofabile dal client', async () => {
    await invia(famiglia({ presa_visione_informativa: true, versione_informativa: '1999-01-01' }))
    const log = h.inserts[0].consents_log as Record<string, unknown>
    expect(log.versione_informativa).toBe(VERSIONE_PRIVACY)
    expect(log.versione_informativa).not.toBe('1999-01-01')
  })

  it('i consensi foto rifiutati vengono registrati come rifiutati, non omessi', async () => {
    // Un consenso mancante e un consenso negato non sono la stessa cosa: la
    // prova deve poter distinguere «non gliel'abbiamo chiesto» da «ha detto no».
    await invia(famiglia({ presa_visione_informativa: true, consenso_foto_galleria: false }))
    const log = h.inserts[0].consents_log as Record<string, unknown>
    const blocchi = log.blocchi as { field_id: string; accepted: boolean }[]
    const galleria = blocchi.find((b) => b.field_id === 'consenso_foto_galleria')
    expect(galleria).toBeTruthy()
    expect(galleria?.accepted).toBe(false)
  })
})
