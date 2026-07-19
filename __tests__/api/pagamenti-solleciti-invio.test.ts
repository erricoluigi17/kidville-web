import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sendEmail: vi.fn(async (opts: { to: string; subject: string; text: string }) => Boolean(opts)),
  enqueueNotifiche: vi.fn(async () => {}),
  pagamenti: [] as Record<string, unknown>[],
  sollecitiEsistenti: [] as Record<string, unknown>[],
  settingsRows: [] as Record<string, unknown>[],
  settingsRow: {} as Record<string, unknown>,
  legami: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
  quote: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/email/send', () => ({ sendEmail: h.sendEmail }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.lt = () => b
      b.neq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: table === 'admin_settings' ? h.settingsRow : null, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return { then: (r: (v: unknown) => unknown) => r({ data: null, error: null }), select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); return b }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data:
            table === 'pagamenti' ? h.pagamenti
            : table === 'solleciti' ? h.sollecitiEsistenti
            : table === 'admin_settings' ? h.settingsRows
            : table === 'legame_genitori_alunni' ? h.legami
            : table === 'utenti' ? h.utenti
            : table === 'pagamenti_quote' ? h.quote
            : [],
          error: null,
        })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/solleciti/route'
import { POST as RUN } from '@/app/api/pagamenti/solleciti/run/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1'
const PID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/solleciti', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.pagamenti = [{
    id: PID, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta Giugno', importo: 150, importo_pagato: 0,
    stato: 'scaduto', scadenza: '2026-06-05', tipo: 'singolo', ultimo_sollecito_il: null,
    // CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
    alunni: { nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'TSTTST00T00T000T' },
  }]
  h.sollecitiEsistenti = []
  h.settingsRow = { solleciti_config: {}, fiscale_config: { denominazione: 'Kidville' }, aruba_config: {} }
  h.legami = [{ genitore_id: 'g-1' }]
  h.utenti = [{ id: 'g-1', email: 'genitore@test.it', nome: 'Giulia', cognome: 'Farina' }]
  h.quote = []
})

describe('POST /api/pagamenti/solleciti', () => {
  it('anteprima: rende i testi SENZA inviare nulla', async () => {
    const res = await POST(post({ pagamento_ids: [PID], anteprima: true }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].ok).toBe(true)
    expect(j.data[0].corpo).toContain('Mario Rossi')
    // Importi in formato it-IT (virgola decimale), MAI in stile US col punto.
    expect(j.data[0].corpo).toContain('150,00')
    expect(j.data[0].corpo).not.toContain('150.00')
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })

  // E1 — l'email deve riportare gli importi in it-IT: virgola decimale e punto
  // separatore delle migliaia («€ 1.234,50»), mai lo stile US «1234.50».
  it('importi in it-IT: separatore migliaia + virgola decimale nel corpo email', async () => {
    h.pagamenti[0].importo = 1234.5
    h.pagamenti[0].importo_pagato = 0
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const text = (h.sendEmail.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('1.234,50')
    expect(text).not.toContain('1234.50')
    expect(text).not.toContain('1234.5')
  })

  it('invio: email al genitore, log a registro e ultimo_sollecito_il aggiornato', async () => {
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'genitore@test.it' })
    expect(h.inserts.some((i) => i.table === 'solleciti')).toBe(true)
    expect(h.updates.some((u) => u.table === 'pagamenti' && u.row.ultimo_sollecito_il)).toBe(true)
    expect(h.enqueueNotifiche).toHaveBeenCalled()
  })

  // Causale bonifico: il corpo dell'email deve portare la causale consigliata col
  // CF del bambino (abbinamento univoco dei bonifici in riconciliazione).
  it('causale: il corpo email contiene «Nome Cognome CF» del bambino', async () => {
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const text = (h.sendEmail.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('Mario Rossi TSTTST00T00T000T')
    expect(text.toLowerCase()).toContain('causale')
  })

  it('anti-spam: sollecito recente → saltato con motivo cadenza', async () => {
    h.pagamenti[0].ultimo_sollecito_il = new Date().toISOString()
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(j.data[0].motivo).toContain('cadenza')
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('saldato → saltato', async () => {
    h.pagamenti[0].stato = 'pagato'
    h.pagamenti[0].importo_pagato = 150
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ pagamento_ids: [PID] }))).status).toBe(403)
  })

  // #36 — pagamento split: i destinatari NON sono i tutori del bambino, ma i
  // titolari delle quote (adult_id di pagamenti_quote). Con legami VUOTI, un
  // invio riuscito prova che i destinatari arrivano dalle quote.
  it('#36 split: destinatari risolti dagli adult_id di pagamenti_quote', async () => {
    h.pagamenti[0].tipo = 'split'
    h.quote = [{ adult_id: 'ad-1' }, { adult_id: 'ad-2' }]
    h.utenti = [{ id: 'ad-1', email: 'ad1@test.it' }, { id: 'ad-2', email: 'ad2@test.it' }]
    h.legami = [] // se i destinatari venissero dai legami, non si invierebbe nulla
    const res = await POST(post({ pagamento_ids: [PID] }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].ok).toBe(true)
    expect((j.data[0].destinatari as { id: string }[]).map((d) => d.id)).toEqual(['ad-1', 'ad-2'])
    expect(h.sendEmail).toHaveBeenCalledTimes(2)
    const to = h.sendEmail.mock.calls.map((c) => c[0].to)
    expect(to).toEqual(expect.arrayContaining(['ad1@test.it', 'ad2@test.it']))
  })

  it('#36 split senza quote né legami → nessun destinatario, niente invio', async () => {
    h.pagamenti[0].tipo = 'split'
    h.quote = []
    h.legami = []
    const res = await POST(post({ pagamento_ids: [PID] }))
    const j = await res.json()
    expect(j.data[0].ok).toBe(false)
    expect(j.data[0].motivo).toContain('destinatario')
    expect(h.sendEmail).not.toHaveBeenCalled()
  })
})

describe('POST /api/pagamenti/solleciti/run', () => {
  it('401 senza x-cron-secret', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('con secret ma nessuna scuola abilitata → 0 invii', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: false } }]
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.inviati).toBe(0)
    expect(h.sendEmail).not.toHaveBeenCalled()
    // il run aggiorna comunque gli scaduti (sostituisce genera_solleciti SQL)
    expect(h.updates.some((u) => u.table === 'pagamenti' && u.row.stato === 'scaduto')).toBe(true)
  })

  // #34 — giro automatico con scuola abilitata e candidato scaduto/obbligatorio:
  // deve INVIARE, escludendo il contenitore rateale `tipo='padre'`.
  it('#34 cron: config abilitata + candidato scaduto → invia ed ESCLUDE il contenitore padre', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: true } }]
    h.pagamenti = [
      { id: PID, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta', importo: 150, importo_pagato: 0,
        stato: 'scaduto', scadenza: '2026-06-01', tipo: 'singolo', obbligatorio: true, ultimo_sollecito_il: null,
        alunni: { nome: 'Mario', cognome: 'Rossi' } },
      { id: PID2, alunno_id: 'al-2', scuola_id: 'sc-1', descrizione: 'Rateale annuale', importo: 300, importo_pagato: 0,
        stato: 'scaduto', scadenza: '2026-06-01', tipo: 'padre', obbligatorio: true, ultimo_sollecito_il: null,
        alunni: { nome: 'Luca', cognome: 'Bianchi' } },
    ]
    const res = await RUN(new Request('http://localhost/api/pagamenti/solleciti/run', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.esaminati).toBe(2)
    // solo il pagamento `singolo` è sollecitato; il contenitore `padre` è escluso
    expect(j.inviati).toBe(1)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'genitore@test.it' })
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
  })
})
