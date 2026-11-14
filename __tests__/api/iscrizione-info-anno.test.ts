// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_DEMO } from '../fixtures/sedi'

/**
 * `GET /api/iscrizione/info-anno?scuola_id=&anno_id=` — ciò che il modulo pubblico mostra alla famiglia per un anno:
 * la quota di nuova iscrizione (listino, voce `quota_nuova`) e l'elenco dei documenti (moduli richiesti, lista `nuova`).
 * Solo configurazione pubblica, mai righe di bambini; l'anno deve essere uno di quelli con le domande aperte.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  rl: { ok: true, remaining: 29, retryAfterMs: 0 },
  logEvento: vi.fn(),
}))

vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: vi.fn(() => h.rl), clientIp: vi.fn(() => 'ip') }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})

import { GET } from '@/app/api/iscrizione/info-anno/route'
import { GET as ELENCO_SEDI } from '@/app/api/iscrizione/sedi/route'
import { rateLimit } from '@/lib/security/rate-limit'

const A_CORR = 'a2222222-2222-4222-8222-222222222222'
const A_PROSS = 'a3333333-3333-4333-8333-333333333333'
const A_CHIUSO = 'a1111111-1111-4111-8111-111111111111'
const S_A_PROSS = 'b3333333-3333-4333-8333-333333333333'
const S_A_CORR = 'b2222222-2222-4222-8222-222222222222'
const S_DEMO_PROSS = 'b7777777-7777-4777-8777-777777777777'
const S_B_PROSS = 'b8888888-8888-4888-8888-888888888888'

const chiedi = (scuola?: string, anno?: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/iscrizione/info-anno?${scuola ? `scuola_id=${scuola}` : ''}${anno ? `&anno_id=${anno}` : ''}`,
    ),
  )
type Corpo = { success?: boolean; data?: { quote: { fascia: string | null; importo: number }[]; moduli: { codice: string; titolo: string }[] }; codice?: string }

beforeEach(() => {
  h.errori = {}
  h.rl = { ok: true, remaining: 29, retryAfterMs: 0 }
  h.logEvento.mockClear()
  h.db = {
    schools: [
      { id: SEDE_A, nome: 'Sede Alfa' },
      { id: SEDE_B, nome: 'Sede Beta' },
      { id: SEDE_DEMO, nome: 'Kidville Demo' },
    ],
    scuole: [],
    anni_scolastici: [
      { id: A_CHIUSO, anno_inizio: 2025, etichetta_breve: '2025/26' },
      { id: A_CORR, anno_inizio: 2026, etichetta_breve: '2026/27' },
      { id: A_PROSS, anno_inizio: 2027, etichetta_breve: '2027/28' },
    ],
    anni_sede: [
      { id: S_A_CORR, scuola_id: SEDE_A, anno_id: A_CORR, stato: 'corrente', domande_aperte: true },
      { id: S_A_PROSS, scuola_id: SEDE_A, anno_id: A_PROSS, stato: 'iscrizioni_aperte', domande_aperte: true },
      { id: S_B_PROSS, scuola_id: SEDE_B, anno_id: A_PROSS, stato: 'in_preparazione', domande_aperte: false },
      { id: S_DEMO_PROSS, scuola_id: SEDE_DEMO, anno_id: A_PROSS, stato: 'iscrizioni_aperte', domande_aperte: true },
    ],
    listino_voci: [
      { anno_sede_id: S_A_PROSS, voce: 'quota_nuova', fascia: null, importo: 120, scadenza: null },
      { anno_sede_id: S_A_PROSS, voce: 'quota_conferma', fascia: null, importo: 80, scadenza: null },
      { anno_sede_id: S_A_PROSS, voce: 'retta', fascia: 'infanzia', importo: 400, scadenza: null },
      { anno_sede_id: S_DEMO_PROSS, voce: 'quota_nuova', fascia: null, importo: 50, scadenza: null },
    ],
    moduli_richiesti: [
      { anno_sede_id: S_A_PROSS, lista: 'nuova', codice: 'b', titolo: 'Certificato vaccinale', ordine: 2 },
      { anno_sede_id: S_A_PROSS, lista: 'nuova', codice: 'a', titolo: 'Delega al ritiro', ordine: 1 },
      { anno_sede_id: S_A_PROSS, lista: 'conferma', codice: 'c', titolo: 'Solo per chi conferma', ordine: 1 },
      { anno_sede_id: S_DEMO_PROSS, lista: 'nuova', codice: 'd', titolo: 'Modulo di prova', ordine: 1 },
    ],
  }
})

describe('GET /api/iscrizione/info-anno', () => {
  it('anno singolo: la quota di nuova iscrizione e i documenti della lista «nuova», in ordine; niente conferma, niente rette', async () => {
    const res = await chiedi(SEDE_A, A_PROSS)
    expect(res.status).toBe(200)
    const c = (await res.json()) as Corpo
    expect(c.data?.quote).toEqual([{ fascia: null, importo: 120 }])
    expect(c.data?.moduli).toEqual([
      { codice: 'a', titolo: 'Delega al ritiro' },
      { codice: 'b', titolo: 'Certificato vaccinale' },
    ])
    expect(JSON.stringify(c)).not.toContain('Solo per chi conferma')
  })

  it('due anni: ognuno ha la sua quota e i suoi documenti (l’anno corrente non ne ha: vuoti, non quelli dell’altro)', async () => {
    const res = await chiedi(SEDE_A, A_CORR)
    expect(res.status).toBe(200)
    const c = (await res.json()) as Corpo
    expect(c.data).toEqual({ quote: [], moduli: [] })
  })

  it('quota assente nel listino: nessun importo inventato', async () => {
    h.db.listino_voci = h.db.listino_voci.filter((r) => r.voce !== 'quota_nuova')
    const c = (await (await chiedi(SEDE_A, A_PROSS)).json()) as Corpo
    expect(c.data?.quote).toEqual([])
    expect(c.data?.moduli).toHaveLength(2)
  })

  it('un importo nullo o non positivo non è una quota', async () => {
    h.db.listino_voci = [
      { anno_sede_id: S_A_PROSS, voce: 'quota_nuova', fascia: null, importo: null, scadenza: null },
      { anno_sede_id: S_A_PROSS, voce: 'quota_nuova', fascia: 'nido_1', importo: 0, scadenza: null },
    ]
    const c = (await (await chiedi(SEDE_A, A_PROSS)).json()) as Corpo
    expect(c.data?.quote).toEqual([])
  })

  it('sede Demo raggiunta col suo id: legge la configurazione della Demo, non quella di un’altra sede', async () => {
    const res = await chiedi(SEDE_DEMO, A_PROSS)
    expect(res.status).toBe(200)
    const c = (await res.json()) as Corpo
    expect(c.data?.quote).toEqual([{ fascia: null, importo: 50 }])
    expect(c.data?.moduli).toEqual([{ codice: 'd', titolo: 'Modulo di prova' }])
  })

  it('un anno senza le domande aperte per quella sede non si legge: 422', async () => {
    const res = await chiedi(SEDE_B, A_PROSS)
    expect(res.status).toBe(422)
    expect(((await res.json()) as Corpo).codice).toBe('ANNO_NON_OFFERTO')
  })

  it('un anno che la sede non ha: 422', async () => {
    expect((await chiedi(SEDE_A, A_CHIUSO)).status).toBe(422)
  })

  it('una sede che non è del deployment: 400, e non dice nulla del listino', async () => {
    const res = await chiedi('99999999-9999-4999-8999-999999999999', A_PROSS)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('importo')
  })

  it('parametri mancanti o non uuid: 400', async () => {
    expect((await chiedi(SEDE_A)).status).toBe(400)
    expect((await chiedi(SEDE_A, 'non-un-uuid')).status).toBe(400)
  })

  it('rate limit: 429', async () => {
    h.rl = { ok: false, remaining: 0, retryAfterMs: 5000 }
    expect((await chiedi(SEDE_A, A_PROSS)).status).toBe(429)
  })

  it('database in ritardo (tabella assente): 200 vuoto, come il modulo di oggi', async () => {
    h.errori = { moduli_richiesti: { code: '42P01', message: 'relation does not exist' } }
    const res = await chiedi(SEDE_A, A_PROSS)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Corpo).data).toEqual({ quote: [], moduli: [] })
  })

  it('guasto vero di lettura: 500 e un log di errore senza titoli né importi', async () => {
    h.errori = { listino_voci: { code: 'XX000', message: 'boom' } }
    const res = await chiedi(SEDE_A, A_PROSS)
    expect(res.status).toBe(500)
    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain('Delega al ritiro')
    expect(log).not.toContain('120')
  })

  // ── Revisione sempl-B · rilievi 2 e 3 ─────────────────────────────────────────────────────────────
  it('rilievo 2 · la Demo risponde SOLO per uuid: con il suo id sì, ma non è nell\'elenco pubblico delle sedi', async () => {
    expect((await chiedi(SEDE_DEMO, A_PROSS)).status).toBe(200)
    const elenco = JSON.stringify(await (await ELENCO_SEDI(new NextRequest('http://localhost/api/iscrizione/sedi'))).json())
    expect(elenco).not.toContain(SEDE_DEMO)
    expect(elenco).toContain(SEDE_A)
  })

  it('rilievo 2 · una sede disattivata si comporta come in `/anni` e nel POST (che usano lo stesso predicato `tutte`): risponde', async () => {
    // Scelta dichiarata: tutte e tre le porte pubbliche validano la sede contro `tutte` di `sediReali`, senza il filtro `attiva`.
    h.db.scuole = [{ id: SEDE_A, attiva: false }]
    expect((await chiedi(SEDE_A, A_PROSS)).status).toBe(200)
  })

  it('rilievo 3 · il tetto è per IP + sede e largo (120/10 min): una sede a un open day non resta senza quota', async () => {
    await chiedi(SEDE_A, A_PROSS)
    const [chiave, opzioni] = vi.mocked(rateLimit).mock.calls.at(-1) as [string, { limit: number; windowMs: number }]
    expect(chiave).toContain(SEDE_A)
    expect(chiave).toContain('ip')
    expect(opzioni.limit).toBe(120)
    expect(opzioni.windowMs).toBe(10 * 60 * 1000)
  })
})
