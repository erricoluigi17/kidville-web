import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * COMPITO 4.6.6 · genera-rette conta le frequenze dell'ANNO e parla con codici.
 * Anteprima e conferma leggono la stessa regola (`rette_da_generare`, M46a); qui si prova la route: l'anno scelto, la strada
 * storica quando il database è indietro, i codici dell'anno al posto del 500, e le notifiche solo per l'anno in corso.
 * Solo uuid finti e nomi inventati; nessun importo vero.
 */

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ANNO = 'b0000000-0000-4000-8000-000000000001'
const AL1 = 'c0000000-0000-4000-8000-000000000001'
const AL2 = 'c0000000-0000-4000-8000-000000000002'
const AL3 = 'c0000000-0000-4000-8000-000000000003'
const AL4 = 'c0000000-0000-4000-8000-000000000004'
const UTENTE = 'd0000000-0000-4000-8000-000000000001'

type Riga = Record<string, unknown>
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  anno: [] as Riga[],
  annoErrore: null as null | { code: string; message: string },
  tabelle: {} as Record<string, Riga[]>,
  pagamentiLetture: [] as Riga[][],
  rpcRette: [] as Riga[],
  rpcErrori: {} as Record<string, { code: string; message: string }>,
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  notifiche: [] as unknown[],
  log: [] as Array<{ livello: string; campi: Record<string, unknown> }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['a0000000-0000-4000-8000-000000000001'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'a0000000-0000-4000-8000-000000000001' }),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async (_s: unknown, p: unknown) => void h.notifiche.push(p) }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (_t: string, livello: string, campi: Record<string, unknown>) => void h.log.push({ livello, campi }),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'not', 'or', 'lte', 'gte', 'limit', 'order', 'insert']) b[m] = () => b
      b.range = () => b
      b.maybeSingle = async () => ({ data: table === 'admin_settings' ? { retta_auto_enabled: true } : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'anni_sede') return resolve(h.annoErrore ? { data: null, error: h.annoErrore } : { data: h.anno, error: null })
        if (table === 'pagamenti' && h.pagamentiLetture.length) return resolve({ data: h.pagamentiLetture.shift(), error: null })
        return resolve({ data: h.tabelle[table] ?? [], error: null })
      }
      return b
    },
    rpc: (nome: string, args: Record<string, unknown>) => {
      h.rpc.push({ nome, args })
      const errore = h.rpcErrori[`${nome}:${'p_anno_sede' in args ? 4 : 3}`] ?? h.rpcErrori[nome]
      const esito = errore ? { data: null, error: errore } : { data: nome === 'rette_da_generare' ? h.rpcRette : 3, error: null }
      // `rette_da_generare` si legge a blocchi (`order` + `range`); le altre funzioni si attendono direttamente
      const q: Record<string, unknown> = { order: () => q, range: (da: number, a: number) => Promise.resolve(errore ? esito : { data: (esito.data as unknown[]).slice(da, a + 1), error: null }) }
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(esito).then(ok)
      return q
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/genera-rette/route'

const get = (qs: string) => new Request(`http://localhost/api/pagamenti/genera-rette?${qs}`)
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/genera-rette', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const riga = (alunno: string, o: Partial<Riga> = {}): Riga => ({
  periodo: '2026-10-01', alunno_id: alunno, frequenza_id: `f-${alunno}`, importo: 250, origine_importo: 'listino',
  esito: 'da_generare', gia_generato: false, posizione: 1, ...o,
})
const alunno = (id: string, nome: string): Riga => ({
  id, nome, cognome: 'Prova', classe_sezione: 'A', section_id: null, importo_retta_mensile: 0, genitori_separati: false, scuola_id: SEDE,
})
const eventi = (esito: string) => h.log.filter((l) => l.campi.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: UTENTE, role: 'admin', scuola_id: SEDE } })
  h.anno = [{ id: ANNO, stato: 'corrente' }]
  h.annoErrore = null
  h.tabelle = { alunni: [alunno(AL1, 'Anna'), alunno(AL2, 'Bruno'), alunno(AL3, 'Carla')], listino_voci: [{ importo: 250 }] }
  h.pagamentiLetture = []
  h.rpcRette = [riga(AL1), riga(AL2, { importo: 310, origine_importo: 'frequenza' }), riga(AL3, { gia_generato: true })]
  h.rpcErrori = {}
  h.rpc = []
  h.notifiche = []
  h.log = []
})

describe('GET — anteprima dall’anno', () => {
  it('mensile: legge rette_da_generare dell’anno e del mese, e mostra solo chi riceverà la retta', async () => {
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE}`))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(h.rpc[0]).toEqual({ nome: 'rette_da_generare', args: { p_anno_sede: ANNO, p_periodo: '2026-10-01', p_alunno_ids: null } })
    expect(data.anno_sede_id).toBe(ANNO)
    expect(data.anno_stato).toBe('corrente')
    expect(data.visibile_alle_famiglie).toBe(true)
    expect(data.candidati.map((c: { id: string }) => c.id).sort()).toEqual([AL1, AL2])
    expect(data.gia_generati).toBe(1)
    expect(data.totale_previsto).toBe(560)
    expect(data.per_origine).toEqual({ listino: 1, frequenza: 1 })
    expect(data.retta_default).toBe(250)
  })

  it('chi non ha un importo non è un candidato ma si conta (senza_importo), con gli esenti e i paganti assenti', async () => {
    h.rpcRette = [
      riga(AL1),
      riga(AL2, { esito: 'senza_importo', importo: null, origine_importo: null }),
      riga(AL3, { esito: 'esente', importo: null, origine_importo: null }),
      riga(AL4, { esito: 'pagante_assente', importo: null, origine_importo: null }),
    ]
    const { data } = await (await GET(get(`periodo=2026-10&scuola_id=${SEDE}`))).json()
    expect(data.candidati).toHaveLength(1)
    expect(data.senza_importo).toBe(1)
    expect(data.esenti).toBe(1)
    expect(data.pagante_assente).toBe(1)
  })

  it('un anno che non è quello in corso dice che le famiglie non lo vedono ancora', async () => {
    h.anno = [{ id: ANNO, stato: 'in_preparazione' }]
    const { data } = await (await GET(get(`periodo=2027-10&scuola_id=${SEDE}`))).json()
    expect(data.visibile_alle_famiglie).toBe(false)
    expect(data.anno_stato).toBe('in_preparazione')
  })

  it('annuale: una riga per mese, con gli id dei candidati e i già generati', async () => {
    h.rpcRette = [
      riga(AL1, { periodo: '2026-09-01' }), riga(AL2, { periodo: '2026-09-01' }),
      riga(AL1, { periodo: '2026-10-01' }), riga(AL2, { periodo: '2026-10-01', gia_generato: true }),
    ]
    const { data } = await (await GET(get(`anno=2026&scuola_id=${SEDE}`))).json()
    expect(h.rpc[0].args).toMatchObject({ p_anno_sede: ANNO, p_periodo: null })
    expect(data.anno_inizio).toBe(2026)
    expect(data.mesi.map((m: { periodo: string; candidati: number; gia_generati: number }) => [m.periodo, m.candidati, m.gia_generati])).toEqual([
      ['2026-09-01', 2, 0],
      ['2026-10-01', 1, 1],
    ])
    expect(data.mesi[0].candidati_ids.sort()).toEqual([AL1, AL2])
    expect(data.totale_candidati).toBe(3)
    expect(data.totale_previsto).toBe(750)
  })

  it('nessun anno per quel mese → 404 con il codice, mai un’anteprima inventata', async () => {
    h.anno = []
    const res = await GET(get(`periodo=2031-10&scuola_id=${SEDE}`))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ANNO_NON_TROVATO')
    expect(h.rpc).toEqual([])
  })

  it('mese fuori dall’anno (ANNO_NON_COERENTE) → 422 con il codice', async () => {
    h.rpcErrori.rette_da_generare = { code: 'P0001', message: 'ANNO_NON_COERENTE' }
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE}`))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_COERENTE')
  })

  it('database indietro (funzione assente): torna alla strada storica e risponde 200 con la forma di sempre', async () => {
    h.rpcErrori.rette_da_generare = { code: 'PGRST202', message: 'funzione assente' }
    h.tabelle.alunni = [{ ...alunno(AL1, 'Anna'), data_iscrizione: null, retta_a_carico_di: null }]
    const res = await GET(get(`periodo=2026-10&scuola_id=${SEDE}`))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.candidati).toHaveLength(1)
    expect(data).not.toHaveProperty('anno_sede_id')
    expect(eventi('rette-schema-indietro').length).toBeGreaterThan(0)
  })
})

describe('POST — la conferma con l’anno', () => {
  it('mensile: passa l’anno alla funzione SQL e porta nella risposta l’anno e i senza importo', async () => {
    h.rpcRette = [riga(AL1), riga(AL2, { esito: 'senza_importo', importo: null, origine_importo: null })]
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    const genera = h.rpc.find((r) => r.nome === 'genera_rette_mensili')
    expect(genera?.args).toEqual({ p_periodo: '2026-10-01', p_scuola_id: SEDE, p_alunno_ids: null, p_anno_sede: ANNO })
    expect(data).toMatchObject({ anno_sede_id: ANNO, senza_importo: 1, visibile_alle_famiglie: true, generati: 3 })
  })

  it('il riepilogo va nel log: un info e un warn per i bambini senza retta, solo conteggi e uuid', async () => {
    h.rpcRette = [riga(AL1), riga(AL2, { esito: 'senza_importo', importo: null, origine_importo: null })]
    await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(eventi('rette-riepilogo')[0].campi).toMatchObject({ n: 1, entita_id: ANNO, scuola_id: SEDE })
    expect(eventi('rette-senza-importo')[0].livello).toBe('warn')
    expect(eventi('rette-generate')[0].campi).toMatchObject({ entita_id: ANNO, generati: 3 })
    expect(JSON.stringify(h.log)).not.toMatch(/Anna|Bruno|Prova/)
  })

  it('annuale: l’anno di inizio e l’anno di sede viaggiano insieme', async () => {
    await POST(post({ anno: 2026, scuola_id: SEDE }))
    const genera = h.rpc.find((r) => r.nome === 'genera_rette_anno')
    expect(genera?.args).toEqual({ p_anno_inizio: 2026, p_scuola_id: SEDE, p_alunno_ids: null, p_anno_sede: ANNO })
  })

  it('anno in preparazione: le rette si creano ma le famiglie NON ricevono nessuna notifica, e il log lo dice', async () => {
    h.anno = [{ id: ANNO, stato: 'in_preparazione' }]
    h.pagamentiLetture = [[], [{ alunno_id: AL1, visibile_dal: null }]]
    const res = await POST(post({ periodo: '2027-10', scuola_id: SEDE }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.visibile_alle_famiglie).toBe(false)
    expect(h.notifiche).toEqual([])
    expect(eventi('notifica-saltata-anno-non-attivo')).toHaveLength(1)
  })

  it('anno in corso: la notifica parte come sempre per chi non aveva la retta', async () => {
    h.pagamentiLetture = [[], [{ alunno_id: AL1, visibile_dal: null }]]
    await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(h.notifiche).toHaveLength(1)
    expect(h.notifiche[0]).toMatchObject({ tipo: 'pagamento_emesso', alunnoIds: [AL1] })
  })

  it('funzione a quattro argomenti assente (migrazione non ancora applicata): ripiega sui tre di sempre, con un info', async () => {
    h.rpcErrori['genera_rette_mensili:4'] = { code: 'PGRST202', message: 'funzione assente' }
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(res.status).toBe(200)
    const chiamate = h.rpc.filter((r) => r.nome === 'genera_rette_mensili')
    expect(chiamate).toHaveLength(2)
    expect(chiamate[1].args).toEqual({ p_periodo: '2026-10-01', p_scuola_id: SEDE, p_alunno_ids: null })
    expect(eventi('rette-funzione-vecchia')).toHaveLength(1)
  })

  it.each([
    ['ANNO_NON_APERTO', 409],
    ['ANNO_CHIUSO', 409],
    ['ANNO_NON_COERENTE', 422],
    ['ANNO_NON_TROVATO', 404],
  ])('il rifiuto %s del database diventa %i col suo codice, non un 500 con il messaggio grezzo', async (codice, stato) => {
    h.rpcErrori.genera_rette_mensili = { code: 'P0001', message: codice }
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(res.status).toBe(stato)
    const corpo = await res.json()
    expect(corpo.codice).toBe(codice)
    expect(h.notifiche).toEqual([])
  })

  it('un guasto vero della funzione resta un 500, senza il messaggio del database', async () => {
    h.rpcErrori.genera_rette_mensili = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(post({ periodo: '2026-10', scuola_id: SEDE }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('statement timeout')
  })

  it('nessun anno per il mese → 404 e nessuna scrittura', async () => {
    h.anno = []
    const res = await POST(post({ periodo: '2031-10', scuola_id: SEDE }))
    expect(res.status).toBe(404)
    expect(h.rpc.find((r) => r.nome === 'genera_rette_mensili')).toBeUndefined()
  })
})
