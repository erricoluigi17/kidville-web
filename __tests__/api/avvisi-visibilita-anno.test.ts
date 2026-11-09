import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · Avvisi di una famiglia: chi riceve cosa lo dice `avvisi_visibili_genitore`, in bacheca e nell'adesione. La funzione finta
 * risponde con coppie già decise, perché quella vera è provata in `__tests__/db/anno-visibilita-genitore.test.ts`; qui si prova che
 * la route le rispetti e non le allarghi: il caso che decide è una coppia che il nome di classe darebbe diversa. Solo uuid finti.
 */

const GEN = '99999999-9999-4999-8999-999999999991'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const FRATELLO = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_ALTRA = '22222222-2222-4222-8222-222222222223'
const FREQ = '66666666-6666-4666-8666-666666666661'
const SEZ = '55555555-5555-4555-8555-555555555551'

const AV_SUO = 'aaaaaaaa-0000-4000-8000-000000000001'
const AV_OMONIMO = 'aaaaaaaa-0000-4000-8000-000000000002'
const AV_ALTRA_SEDE = 'aaaaaaaa-0000-4000-8000-000000000003'
const AV_SCADUTO = 'aaaaaaaa-0000-4000-8000-000000000004'

const FRA_30_GIORNI = new Date(Date.now() + 30 * 86_400_000).toISOString()
const IERI = new Date(Date.now() - 86_400_000).toISOString()

type Rpc = (args: Riga) => RispostaRpc

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  coppie: null as unknown,
  figliAttivi: null as unknown,
  adesioni: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: vi.fn(async () => [SEDE]),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: SEDE })),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: h.getFigliDiGenitore,
  genitoreHasFiglio: h.genitoreHasFiglio,
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn(async () => []),
  genitoriDiScuola: vi.fn(async () => []),
  genitoriDiClassi: vi.fn(async () => []),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: vi.fn(async () => ({})) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: vi.fn(async () => null) }))
vi.mock('@/lib/avvisi/statistiche', async (orig) => ({
  ...(await orig<typeof import('@/lib/avvisi/statistiche')>()),
  statistichePerAvviso: vi.fn(async () => new Map()),
  autoriDegliAvvisi: vi.fn(async () => new Map()),
  rispostePerAvvisoDelGenitore: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/allegati/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/allegati/storage')>()),
  firmaAllegatiAvvisi: vi.fn(async (_c: unknown, righe: unknown) => righe),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.lette, {
    rpc: {
      avvisi_visibili_genitore: (args: Riga) => (h.coppie as Rpc)(args),
      figli_attivi: (args: Riga) => (h.figliAttivi as Rpc)(args),
      avviso_adesione_registra: (args: Riga) => {
        h.adesioni.push(args)
        return {
          data: {
            ok: true, stato: 'ammessa', numero: 1, prima_lettura: true, prima_risposta: true, posti_liberati: 0, in_attesa: 0,
            riga: { id: 'r-nuova', avviso_id: args.p_avviso_id, student_id: args.p_student_id },
          },
          error: null,
        }
      },
    },
  }),
}))

import { GET as BACHECA } from '@/app/api/avvisi/route'
import { POST as ADERISCI } from '@/app/api/avvisi/[id]/risposte/route'

const reqBacheca = () => ({
  url: 'http://test/api/avvisi',
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams() },
  cookies: { get: () => undefined },
}) as never
const reqAdesione = (avviso: string, alunno: string) => ({
  url: `http://test/api/avvisi/${avviso}/risposte`,
  method: 'POST',
  headers: new Headers(),
  json: async () => ({ student_id: alunno, risposta: 'si', numero_partecipanti: 1 }),
}) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const aderisci = (avviso: string, alunno: string) => ADERISCI(reqAdesione(avviso, alunno), ctx(avviso))

type AvvisoOfferto = { id: string; figli: Array<{ student_id: string }> }

const bacheca = async () => {
  const res = await BACHECA(reqBacheca())
  expect(res.status).toBe(200)
  return await res.json() as AvvisoOfferto[]
}

const avviso = (id: string, extra: Record<string, unknown>) => ({
  id, author_id: 'aut-x', titolo: 't', contenuto: 'c', tipo: 'adesione', target_scope: 'classe', target_classes: ['Girasoli'],
  scadenza: null, scadenza_avviso: FRA_30_GIORNI, scadenza_adesione: FRA_30_GIORNI, attachment_url: null, created_at: '2026-10-01',
  scuola_id: SEDE, ...extra,
})

const coppie = (...righe: Array<[string, string]>): Rpc => () => ({
  data: righe.map(([avviso_id, alunno_id]) => ({ avviso_id, alunno_id })),
  error: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.adesioni.length = 0
  h.db = {
    avvisi: [
      avviso(AV_SUO, { created_at: '2026-10-03' }),
      // Stesso nome di classe del figlio, ma la sezione è un'altra: per nome arriverebbe.
      avviso(AV_OMONIMO, { created_at: '2026-10-02' }),
      avviso(AV_ALTRA_SEDE, { scuola_id: SEDE_ALTRA, target_scope: 'globale', target_classes: null, created_at: '2026-10-01' }),
      avviso(AV_SCADUTO, { scadenza_avviso: IERI, scadenza_adesione: IERI, created_at: '2026-09-01' }),
    ],
    alunni: [
      { id: FIGLIO, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', scuola_id: SEDE },
      { id: FRATELLO, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', scuola_id: SEDE },
    ],
    avvisi_risposte: [],
    utenti: [],
  }
  h.requireUser.mockResolvedValue({ user: { id: GEN, role: 'genitore', ruoli: ['genitore'] } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.getFigliDiGenitore.mockResolvedValue([FIGLIO])
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
  h.figliAttivi = (() => ({
    data: [{ alunno_id: FIGLIO, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE }],
    error: null,
  })) as Rpc
  h.coppie = coppie([AV_SUO, FIGLIO])
})

describe('GET /api/avvisi, famiglia', () => {
  it('riceve le coppie della funzione: la sezione omonima no', async () => {
    const feed = await bacheca()

    expect(feed.map((a) => a.id)).toEqual([AV_SUO])
    expect(feed[0].figli.map((f) => f.student_id)).toEqual([FIGLIO])
  })

  it('i bambini offerti sono quelli della coppia, anche fra due fratelli con lo stesso nome di classe', async () => {
    h.getFigliDiGenitore.mockResolvedValue([FIGLIO, FRATELLO])
    h.figliAttivi = (() => ({
      data: [FIGLIO, FRATELLO].map((a) => ({ alunno_id: a, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE })),
      error: null,
    })) as Rpc
    h.coppie = coppie([AV_SUO, FIGLIO], [AV_OMONIMO, FRATELLO])

    const feed = await bacheca()

    expect(feed.find((a) => a.id === AV_SUO)?.figli.map((f) => f.student_id)).toEqual([FIGLIO])
    expect(feed.find((a) => a.id === AV_OMONIMO)?.figli.map((f) => f.student_id)).toEqual([FRATELLO])
  })

  it('un bambino vivo in due sedi riceve anche l’avviso della sede che non è scritta in anagrafica', async () => {
    h.figliAttivi = (() => ({
      data: [
        { alunno_id: FIGLIO, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE },
        { alunno_id: FIGLIO, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE_ALTRA },
      ],
      error: null,
    })) as Rpc
    h.coppie = coppie([AV_SUO, FIGLIO], [AV_ALTRA_SEDE, FIGLIO])

    const feed = await bacheca()

    expect(feed.map((a) => a.id)).toEqual([AV_SUO, AV_ALTRA_SEDE])
  })

  it('nessun figlio attivo: lista vuota, senza leggere gli avvisi', async () => {
    h.coppie = coppie()
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    expect(await bacheca()).toEqual([])
    expect(h.lette).not.toContain('avvisi')
  })

  it('il legame non basta più: `getFigliDiGenitore` non viene nemmeno chiamata', async () => {
    await bacheca()

    expect(h.getFigliDiGenitore).not.toHaveBeenCalled()
  })

  it('un guasto della funzione non apre: 500, e gli avvisi non si leggono', async () => {
    h.coppie = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await BACHECA(reqBacheca())

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.lette).not.toContain('avvisi')
  })

  it('un guasto dei figli attivi non apre', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await BACHECA(reqBacheca())

    expect(res.status).toBe(500)
    expect(h.lette).not.toContain('avvisi')
  })

  it('schema indietro: il confronto per nome di oggi, con un `info`', async () => {
    const indietro = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc
    h.coppie = indietro
    h.figliAttivi = indietro

    const feed = await bacheca()

    // Per nome arrivano anche i due che la funzione non darebbe, ed è il comportamento di oggi.
    expect(feed.map((a) => a.id)).toEqual([AV_SUO, AV_OMONIMO])
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({
      operazione: 'anno/visibilita:avvisi_visibili_genitore',
      esito: 'schema-indietro',
    }))
  })
})

describe('POST /api/avvisi/[id]/risposte, famiglia', () => {
  it('🔑 ciò che la bacheca offre, il server accetta', async () => {
    const feed = await bacheca()
    const bottoni = feed.flatMap((a) => a.figli.map((f) => ({ avviso: a.id, alunno: f.student_id })))
    expect(bottoni.length).toBeGreaterThan(0)

    for (const b of bottoni) expect((await aderisci(b.avviso, b.alunno)).status).toBe(200)
  })

  it('ciò che la funzione non dà si rifiuta, anche se il nome di classe combacia', async () => {
    const res = await aderisci(AV_OMONIMO, FIGLIO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'ADESIONE_ALUNNO_FUORI_AVVISO' })
    expect(h.adesioni).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith('avvisi', 'warn', expect.objectContaining({
      esito: 'adesione-alunno-fuori-avviso',
      tipo: 'funzione',
    }))
  })

  it('la coppia della funzione passa anche con la sede dell’anagrafica diversa', async () => {
    h.coppie = coppie([AV_ALTRA_SEDE, FIGLIO])

    expect((await aderisci(AV_ALTRA_SEDE, FIGLIO)).status).toBe(200)
    expect(h.adesioni).toHaveLength(1)
  })

  it('l’avviso scaduto non è «non ti riguarda»: decide la funzione di adesione, col suo termine', async () => {
    expect((await aderisci(AV_SCADUTO, FIGLIO)).status).toBe(200)
    expect(h.adesioni).toHaveLength(1)
  })

  it('l’avviso scaduto di un’altra sede resta fuori', async () => {
    h.db.avvisi.push(avviso('aaaaaaaa-0000-4000-8000-000000000005', { scuola_id: SEDE_ALTRA, scadenza_avviso: IERI }))

    const res = await aderisci('aaaaaaaa-0000-4000-8000-000000000005', FIGLIO)

    expect(res.status).toBe(403)
    expect(h.adesioni).toEqual([])
  })

  it('un guasto della funzione non apre: 503 e nessuna adesione', async () => {
    h.coppie = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await aderisci(AV_SUO, FIGLIO)

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ codice: 'ADESIONI_NON_DISPONIBILI' })
    expect(h.adesioni).toEqual([])
  })

  it('schema indietro: il cerchio per nome di oggi', async () => {
    h.coppie = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc

    expect((await aderisci(AV_OMONIMO, FIGLIO)).status).toBe(200)
    expect((await aderisci(AV_ALTRA_SEDE, FIGLIO)).status).toBe(403)
  })
})

// ─── PR 4.5 · il bambino «in arrivo» e lo schema indietro ───────────────────────────────────────────────────────────────────
// Dove la funzione `figli_attivi` non c'è (la CI) la bacheca riparte dai figli COLLEGATI. Un bambino la cui domanda è per l'anno dopo
// è collegato, ha una sede e nessuna classe: senza un filtro sullo stato la famiglia riceverebbe gli avvisi della scuola come se
// frequentasse. Il finto database filtra davvero: il bambino è una riga con `stato = 'in_arrivo'`.
describe('GET /api/avvisi, famiglia · il bambino in arrivo, con lo schema indietro', () => {
  const ARRIVO = '11111111-1111-4111-8111-111111111119'
  const AV_GLOBALE = 'aaaaaaaa-0000-4000-8000-000000000009'
  const schemaIndietro: Rpc = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })

  beforeEach(() => {
    h.coppie = schemaIndietro
    h.figliAttivi = schemaIndietro
    h.db.avvisi = [avviso(AV_GLOBALE, { target_scope: 'globale', target_classes: null, tipo: 'info' })]
    h.db.alunni = [
      { id: FIGLIO, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', scuola_id: SEDE, stato: 'iscritto' },
      { id: ARRIVO, nome: 'n', cognome: 'c', classe_sezione: null, scuola_id: SEDE, stato: 'in_arrivo' },
    ]
  })

  it('un genitore il cui SOLO figlio è in arrivo non riceve nessun avviso della scuola', async () => {
    h.getFigliDiGenitore.mockResolvedValue([ARRIVO])
    expect(await bacheca()).toEqual([])
  })

  it('con un fratello che frequenta, gli avvisi arrivano per lui e il bambino in arrivo non è fra i figli offerti', async () => {
    h.getFigliDiGenitore.mockResolvedValue([FIGLIO, ARRIVO])
    const feed = await bacheca()
    expect(feed.map((a) => a.id)).toEqual([AV_GLOBALE])
    expect(feed[0].figli.map((f) => f.student_id)).toEqual([FIGLIO])
  })
})
