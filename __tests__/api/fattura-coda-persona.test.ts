import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * `POST /api/pagamenti/fattura/coda` con l'intestatario scritto a mano («Altro», consegna 2b, D1).
 *
 * La persona entra in coda dal pulsante, UNA voce per volta, e la POST la valida con le stesse
 * regole dell'emissione (`validaCessionario`) PRIMA di ogni lettura del DB: una persona incompleta
 * non deve diventare, un giro dopo, un «errore» in coda. E nei log non esce mai un suo dato.
 *
 * ⚠️ Repo PUBBLICO: la persona è il cast SINTETICO di `FatturaButton-intestatario.test.tsx`
 * (`COMPLETI`, `CF_DIGITATO`), ricopiato qui come `PERSONA`. Gli uuid sono finti.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  scuole: vi.fn(),
  logEvento: vi.fn(),
  sb: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async (originale) => {
  const actual = await originale<typeof import('@/lib/auth/scope')>()
  return { ...actual, assertPagamentoInScope: h.scope, scuoleDiUtente: h.scuole }
})
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.sb }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { POST } from '@/app/api/pagamenti/fattura/coda/route'
import { redactInput } from '@/lib/logging/redact'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const STAFF = uuid(7000)
const PAG = uuid(1)

const PERSONA = {
  tipo: 'persona' as const,
  nome: 'Carlo',
  cognome: 'Perlini',
  codice_fiscale: 'PRLCRL85M41H501Y',
  indirizzo: 'Via delle Prove 1',
  cap: '80014',
  comune: 'Giugliano in Campania',
}
/** I sei valori che non devono comparire in nessun log. */
const VALORI_PERSONALI = [
  PERSONA.nome,
  PERSONA.cognome,
  PERSONA.codice_fiscale,
  PERSONA.indirizzo,
  PERSONA.cap,
  PERSONA.comune,
]

type Rpc = Record<string, (args: Riga) => RispostaRpc>

let db: DBFinto
let tabelleLette: string[]
let rpcChiamate: { nome: string; args: Riga }[]

function monta() {
  rpcChiamate = []
  tabelleLette = []
  const rpc: Rpc = {
    fatture_coda_accoda: () => ({ data: { gruppo_id: uuid(8000), accodate: 1, gia_in_coda: [] }, error: null }),
    fatture_coda_tick_http: () => ({ data: null, error: null }),
  }
  const tracciate: Rpc = Object.fromEntries(
    Object.entries(rpc).map(([nome, impl]) => [
      nome,
      (args: Riga) => {
        rpcChiamate.push({ nome, args })
        return impl(args)
      },
    ]),
  )
  h.sb = creaFintoSupabase(db, tabelleLette, { rpc: tracciate })
}

const rpcDi = (nome: string) => rpcChiamate.filter((c) => c.nome === nome)

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

/** Gli esiti di `logEvento`, per nome. */
function logCon(esito: string) {
  return h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
}

function nessunDatoPersonale(testo: string) {
  for (const v of VALORI_PERSONALI) expect(testo).not.toContain(v)
}

beforeEach(() => {
  vi.clearAllMocks()
  db = {
    pagamenti: [{ id: PAG, stato: 'pagato', scuola_id: SEDE_A }],
  }
  monta()
  h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } })
  h.scope.mockResolvedValue(null)
  h.scuole.mockResolvedValue([SEDE_A])
})

describe('POST /coda — la persona scritta a mano entra in coda', () => {
  it('1. persona completa, urgente, «ricorda sulla scheda» ⇒ 200, e la RPC la riceve intera', async () => {
    const res = await POST(
      post({ urgente: true, voci: [{ pagamento_id: PAG, intestatario: PERSONA, conferma_proposta: true }] }),
    )
    expect(res.status).toBe(200)
    const [accoda] = rpcDi('fatture_coda_accoda')
    expect(accoda.args.p_urgente).toBe(true)
    expect((accoda.args.p_voci as unknown[])[0]).toEqual({
      pagamento_id: PAG,
      intestatario_scelto: PERSONA,
      conferma_proposta: true,
      causale_manuale: null,
      ordine_selezione: 0,
    })
    const accodate = logCon('accodate')
    expect(accodate).toHaveLength(1)
    expect(accodate[0][2]).toMatchObject({ digitati: 1 })
  })

  it('senza persona il contatore dei digitati è zero', async () => {
    await POST(post({ voci: [{ pagamento_id: PAG }] }))
    expect(logCon('accodate')[0][2]).toMatchObject({ digitati: 0 })
  })
})

describe('POST /coda — la persona incompleta si ferma PRIMA di ogni lettura', () => {
  it('2. un CAP di quattro cifre ⇒ 400 INTESTATARIO_DIGITATO_INCOMPLETO, nessuna lettura, nessuna RPC', async () => {
    const res = await POST(post({ voci: [{ pagamento_id: PAG, intestatario: { ...PERSONA, cap: '8001' } }] }))
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).toBe('INTESTATARIO_DIGITATO_INCOMPLETO')
    expect(corpo.data).toEqual({ pagamento_ids: [PAG] })
    expect(rpcChiamate).toEqual([])
    expect(tabelleLette).toEqual([])
    expect(h.scope).not.toHaveBeenCalled()
    expect(h.scuole).not.toHaveBeenCalled()
    const scarti = logCon('intestatario-digitato-incompleto')
    expect(scarti).toHaveLength(1)
    expect(scarti[0][1]).toBe('warn')
    expect(scarti[0][2]).toMatchObject({ operazione: 'coda:POST', n: 1 })
  })

  it('3. un codice fiscale di forma sbagliata ⇒ lo stesso 400', async () => {
    const res = await POST(
      post({ voci: [{ pagamento_id: PAG, intestatario: { ...PERSONA, codice_fiscale: 'NONUNCODICE' } }] }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('INTESTATARIO_DIGITATO_INCOMPLETO')
    expect(rpcChiamate).toEqual([])
    expect(tabelleLette).toEqual([])
    expect(h.scope).not.toHaveBeenCalled()
  })

  it('5. la persona in una voce più una seconda voce ⇒ 400 di zod, nessuna RPC', async () => {
    db.pagamenti = [...db.pagamenti, { id: uuid(2), stato: 'pagato', scuola_id: SEDE_A }]
    const res = await POST(post({ voci: [{ pagamento_id: PAG, intestatario: PERSONA }, { pagamento_id: uuid(2) }] }))
    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo.codice).not.toBe('INTESTATARIO_DIGITATO_INCOMPLETO')
    expect(rpcChiamate).toEqual([])
    expect(h.scope).not.toHaveBeenCalled()
  })
})

describe('POST /coda — nessun dato della persona nei log', () => {
  it('4. né sul 200 né sul 400, e nemmeno nel corpo redatto', async () => {
    // Presenza prima dell'assenza: i log ci sono, e sono quelli giusti.
    await POST(post({ voci: [{ pagamento_id: PAG, intestatario: PERSONA, conferma_proposta: true }] }))
    expect(logCon('accodate')).toHaveLength(1)
    nessunDatoPersonale(JSON.stringify(h.logEvento.mock.calls))

    h.logEvento.mockClear()
    await POST(post({ voci: [{ pagamento_id: PAG, intestatario: { ...PERSONA, cap: '8001' } }] }))
    expect(logCon('intestatario-digitato-incompleto')).toHaveLength(1)
    // Il CAP sbagliato non deve comparire neanche lui.
    const testo = JSON.stringify(h.logEvento.mock.calls)
    nessunDatoPersonale(testo)
    expect(testo).not.toContain('8001')

    // Il canale del corpo (`http.ts` → `context.ts`) passa da `redactInput`.
    const redatto = JSON.stringify(redactInput({ voci: [{ pagamento_id: PAG, intestatario: PERSONA }] }))
    expect(redatto).toContain(PAG)
    nessunDatoPersonale(redatto)
  })
})
