import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// L'IMPORT DI UNA DOMANDA CHIEDE LA RETTA — e perché non bastava «un campo in più».
//
// ─── IL GUASTO, MISURATO IN PRODUZIONE IL 2026-09-02 ─────────────────────────
// Fino a quel giorno l'import chiedeva solo la classe. Il bambino nasceva con
// `importo_retta_mensile = 0`, e chi genera le rette mensili legge:
//
//     COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150)
//     — supabase/migrations/20260731115341_genera_rette_per_sede.sql:154
//
// `NULLIF(…, 0)` ANNULLA LO ZERO. Ogni bambino importato dal modulo si prendeva
// 150 €/mese senza che nessuno l'avesse deciso, senza che nessun errore comparisse
// da nessuna parte, e senza che nessun test fosse rosso. In archivio, quel giorno,
// quaranta alunni veri erano in quello stato.
//
// ─── PERCHÉ LO ZERO È RIFIUTATO, E NON ACCETTATO COME «NON PAGA» ─────────────
// Perché lo zero, su quella colonna, NON significa «non paga»: significa «usa il
// default di sede». La prova che la trappola morde davvero è che sei bambini in
// produzione avevano la retta a **0,01 €** — il ripiego che la segreteria aveva
// trovato da sola per aggirare lo zero senza sapere perché lo zero non andasse.
// Chi non paga si dichiara con `retta_a_carico_di`, che punta al fratello.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  sezioni: [] as { name: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === 'sections' ? { data: h.sezioni, error: null } : { data: [], error: null },
        ).then(res)
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        // L'id dipende dal NOME: la seconda passata su `retta_a_carico_di` deve
        // poter essere osservata mentre punta a un fratello e non a se stessa, e
        // con un id costante «punta al fratello» e «punta a sé» sarebbero
        // indistinguibili — cioè il test non proverebbe niente.
        return {
          select: () => ({
            single: async () => ({ data: { id: `${table}-${row?.nome ?? 'X'}`, nome: row?.nome ?? 'X' }, error: null }),
          }),
        }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }) }
      }
      b.upsert = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (extra: Record<string, unknown>) =>
  PATCH(req({ id: ID, action: 'import', referenteIndex: 0, ...extra }) as never)

const alunniCreati = () => h.inserts.filter((i) => i.table === 'alunni')
const alunniAggiornati = () => h.updates.filter((u) => u.table === 'alunni')

/** Una domanda con `n` bambini, tutti con codice fiscale (niente dedup soft). */
const domandaCon = (n: number) => ({
  id: ID,
  scuola_id: 'sc-1',
  data: {
    children: Array.from({ length: n }, (_, i) => ({
      nome: `Bimbo${i}`,
      cognome: 'Prova',
      codice_fiscale: `CFC${i}`,
    })),
    adults: [
      { first_name: 'Anna', last_name: 'Rossi', fiscal_code: 'CF1', email: 'anna@example.test' },
      { first_name: 'Bruno', last_name: 'Verdi', fiscal_code: 'CF2', email: 'bruno@example.test' },
    ],
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.eventi = []
  h.sezioni = [{ name: '3 ANNI' }, { name: '4 ANNI' }]
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.sub = domandaCon(1)
})

describe('import iscrizioni — la retta si chiede, e lo zero si rifiuta', () => {
  it('SENZA retta l\'import si ferma con 400, e non scrive NIENTE', async () => {
    const res = await importa({ assignments: { '0': '3 ANNI' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    // Il messaggio deve dire anche la CONSEGUENZA, non solo «campo mancante»:
    // è l'informazione che manca a chi non sa cosa faccia lo zero.
    expect(json.error).toMatch(/retta/i)
    expect(json.error).toMatch(/predefinita/i)
    // Nessuna scrittura parziale: come le altre pre-flight, si rifiuta PRIMA.
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })

  it('retta ZERO: rifiutata, e il messaggio spiega PERCHÉ (vale 150 €)', async () => {
    const res = await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 0 } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/zero|retta/i)
    expect(h.inserts).toHaveLength(0)
  })

  it('retta NEGATIVA: rifiutata dallo schema', async () => {
    const res = await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': -50 } })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('con la retta: l\'alunno nasce con l\'importo giusto, non con lo zero', async () => {
    const res = await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 330.5 } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    const alunni = alunniCreati()
    expect(alunni).toHaveLength(1)
    expect(alunni[0].row.importo_retta_mensile).toBe(330.5)
  })

  it('giorno di scadenza e intestatario fatture, se indicati, arrivano sull\'alunno', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI' },
      rette: { '0': 300 },
      giorniScadenza: { '0': 12 },
      // Il SECONDO adulto, non il referente: se il codice ignorasse l'indice e
      // usasse il referente, questo test resterebbe verde per caso.
      intestatari: { '0': 1 },
    })
    expect(res.status).toBe(200)
    const riga = alunniCreati()[0].row
    expect(riga.giorno_scadenza_pagamenti).toBe(12)
    expect(riga.intestatario_fatture).toMatchObject({ tipo: 'adult', nome: 'Bruno Verdi' })
  })

  it('un giorno di scadenza oltre il 28 è rifiutato: il 31 febbraio non arriva mai', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI' },
      rette: { '0': 300 },
      giorniScadenza: { '0': 31 },
    })
    expect(res.status).toBe(400)
  })

  it('un intestatario che non è fra gli adulti della domanda è rifiutato', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI' },
      rette: { '0': 300 },
      intestatari: { '0': 7 },
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('import iscrizioni — chi non paga, e chi paga per lui', () => {
  beforeEach(() => { h.sub = domandaCon(2) })

  it('«la paga il fratello»: si scrive retta_a_carico_di, MAI uno zero', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' },
      rette: { '0': 450 },
      retteACarico: { '1': 0 }, // il secondo figlio è a carico del primo
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })

    const alunni = alunniCreati()
    expect(alunni).toHaveLength(2)
    // Chi paga ha la cifra…
    expect(alunni[0].row.importo_retta_mensile).toBe(450)
    // …e chi non paga NON ha nessuna cifra. Non lo zero: LA CHIAVE NON C'È.
    // Uno zero qui sarebbe 150 € al mese per dieci mesi a una famiglia che non
    // deve pagare niente, ed è esattamente il difetto che questo test difende.
    expect(alunni[1].row).not.toHaveProperty('importo_retta_mensile')

    // Il collegamento arriva in una SECONDA passata, quando il fratello ha un id.
    const aCarico = alunniAggiornati().filter((u) => 'retta_a_carico_di' in u.row)
    expect(aCarico).toHaveLength(1)
    expect(aCarico[0].row.retta_a_carico_di).toBe('alunni-Bimbo0')
  })

  it('il successo della seconda passata si LOGGA (senza log, «nessuno» e «rotto» si somigliano)', async () => {
    await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' },
      rette: { '0': 450 },
      retteACarico: { '1': 0 },
    })
    const ev = h.eventi.find((e) => e.campi?.esito === 'retta-a-carico-fratello')
    expect(ev).toBeDefined()
    expect(ev?.livello).toBe('info')
    expect(ev?.campi.scritti).toBe(1)
    expect(ev?.campi.falliti).toBe(0)
    // Indici e conteggi, mai nomi di bambini.
    expect(JSON.stringify(ev?.campi)).not.toContain('Bimbo')
  })

  it('a carico di SE STESSO: rifiutato (sarebbe un rimando che non finisce mai)', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' },
      rette: { '0': 450 },
      retteACarico: { '1': 1 },
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('a carico di un fratello che NON esiste nella domanda: rifiutato', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' },
      rette: { '0': 450 },
      retteACarico: { '1': 9 },
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('a carico di un fratello che a sua volta NON paga: rifiutato, non c\'è nessuna cifra in fondo', async () => {
    const res = await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' },
      rette: {},
      retteACarico: { '0': 1, '1': 0 },
    })
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})
