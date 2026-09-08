import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─── IL LOTTO RICORDA CHI HA PAGATO ─────────────────────────────────────────
 *
 * Quando il lotto emette una fattura intestata al genitore RICONOSCIUTO
 * dall'ordinante del bonifico, dal 2026-09-08 quel nome finisce anche sulla scheda
 * del bambino: la fattura del mese dopo non deve più dedurlo, e i 16 pagamenti su 20
 * che il 2026-09-08 non avevano nessun intestatario in anagrafica smettono di essere
 * un caso ricorrente.
 *
 * ⚠️ È UNA SCRITTURA SULL'ANAGRAFICA DI UN MINORE, decisa da un'euristica. Le
 * condizioni sotto le quali NON deve avvenire contano quanto quella sotto cui deve:
 * i casi «già a registro», «ha deciso la cascata» e «l'emissione è fallita» sono la
 * parte di questo file che vale.
 *
 * Qui la Supabase è finta ma la funzione che scrive è VERA
 * (`ricordaIntestatarioSullaScheda`): un mock di quella funzione avrebbe collaudato
 * il mock, e la catena `.eq().is().select()` — che è tutto il contratto — sarebbe
 * rimasta senza nessuno a guardarla.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  emetti: vi.fn(),
  conta: vi.fn(),
  /** Le UPDATE arrivate su `alunni`: è ciò che questo file misura. */
  scritture: [] as { payload: unknown; filtri: Record<string, unknown>; is?: [string, unknown] }[],
  /** Le schede che risultano VUOTE: le altre fanno tornare zero righe toccate. */
  schedeVuote: new Set<string>(),
  /** Fa fallire la UPDATE su `alunni` come farebbe PostgREST: valore, non eccezione. */
  erroreAlunni: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: h.scope }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const ctx: { tabella: string; payload?: unknown; filtri: Record<string, unknown>; is?: [string, unknown]; in?: [string, string[]] } =
        { tabella, filtri: {} }
      const esegui = () => {
        if (tabella === 'alunni' && ctx.payload) {
          h.scritture.push({ payload: ctx.payload, filtri: ctx.filtri, is: ctx.is })
          if (h.erroreAlunni) return { data: null, error: h.erroreAlunni }
          const id = String(ctx.filtri.id ?? '')
          return { data: h.schedeVuote.has(id) ? [{ id }] : [], error: null }
        }
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        update: (v: unknown) => { ctx.payload = v; return chain },
        eq: (c: string, v: unknown) => { ctx.filtri[c] = v; return chain },
        is: (c: string, v: unknown) => { ctx.is = [c, v]; return chain },
        in: (c: string, v: string[]) => { ctx.in = [c, v]; return chain },
        then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esegui()).then(ok, ko),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/pagamenti/tetto-orario-aruba', async (originale) => {
  const actual = await originale<typeof import('@/lib/pagamenti/tetto-orario-aruba')>()
  return { ...actual, contaEmesseUltimaOra: h.conta }
})
vi.mock('@/lib/aruba/emissione', async (originale) => {
  const actual = await originale<typeof import('@/lib/aruba/emissione')>()
  return { ...actual, emettiFatturaPagamento: h.emetti }
})

import { POST } from '@/app/api/pagamenti/fattura/lotto/route'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PAG = uuid(1)
const ALUNNO = uuid(50)
const ADULTO = uuid(900)

function richiesta(conIntestatario: boolean): Request {
  return new Request('http://localhost/api/pagamenti/fattura/lotto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pagamenti: [{
        pagamento_id: PAG,
        causale: null,
        ...(conIntestatario ? { intestatario: { tipo: 'adult', adult_id: ADULTO } } : {}),
      }],
    }),
  })
}

/**
 * ⚠️ `alunnoId` VIENE DALL'ESITO DELL'EMISSIONE, non da una seconda lettura di
 * `pagamenti`. È la stessa riga che ha appena prodotto il documento: due letture
 * separate sarebbero due fonti di verità su «di chi è questo pagamento», e la
 * seconda arriverebbe per giunta senza il gate di sede che la prima ha già passato.
 */
const esitoOk = { ok: true as const, fatturaStato: 'in_attesa' as const, uploadFileName: 'IT_x.p7m', numero: 2332, alunnoId: ALUNNO }

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture.length = 0
  h.schedeVuote = new Set([ALUNNO])
  h.erroreAlunni = null
  h.requireStaff.mockResolvedValue({ response: null, user: { id: 'staff-1' } })
  h.scope.mockResolvedValue(null)
  h.conta.mockResolvedValue(0)
  h.emetti.mockImplementation(async () => esitoOk)
})

describe('l’intestatario proposto finisce sulla scheda del bambino', () => {
  it('emissione NUOVA con intestatario proposto ⇒ la scheda vuota viene scritta, una volta sola', async () => {
    const res = await POST(richiesta(true))
    expect(res.status).toBe(200)

    expect(h.scritture).toHaveLength(1)
    expect(h.scritture[0].payload).toEqual({ intestatario_fatture: { tipo: 'adult', adult_id: ADULTO } })
    expect(h.scritture[0].filtri.id).toBe(ALUNNO)
    // La condizione «la scheda è vuota» viaggia con la UPDATE, non in una lettura
    // fatta prima: fra le due, una persona può averla compilata a mano.
    expect(h.scritture[0].is).toEqual(['intestatario_fatture', null])
  })

  it('fattura GIÀ a registro ⇒ nessuna scrittura: non è stata emessa adesso', async () => {
    h.emetti.mockImplementation(async () => ({ ...esitoOk, gia: true }))
    await POST(richiesta(true))
    expect(h.scritture).toHaveLength(0)
  })

  it('ha deciso la CASCATA (nessun intestatario nel corpo) ⇒ nessuna scrittura', async () => {
    // Senza proposta non c'è niente da ricordare: l'anagrafica sapeva già rispondere.
    await POST(richiesta(false))
    expect(h.scritture).toHaveLength(0)
  })

  it('emissione FALLITA ⇒ nessuna scrittura, nemmeno con l’intestatario nel corpo', async () => {
    h.emetti.mockImplementation(async () => ({
      ok: false as const, motivo: 'errore' as const, messaggio: 'Aruba muta', httpStatus: 502,
    }))
    await POST(richiesta(true))
    expect(h.scritture).toHaveLength(0)
  })

  it('alunno sconosciuto ⇒ nessuna scrittura, e la fattura resta emessa', async () => {
    h.emetti.mockImplementation(async () => ({ ...esitoOk, alunnoId: null }))
    const res = await POST(richiesta(true))
    expect(res.status).toBe(200)
    expect(await res.json().then((j) => j.data.emesse)).toHaveLength(1)
    expect(h.scritture).toHaveLength(0)
  })

  it('se il salvataggio fallisce la fattura resta emessa: è già partita, non si disfa', async () => {
    h.erroreAlunni = { code: '42703', message: 'colonna assente' }
    const res = await POST(richiesta(true))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.emesse).toHaveLength(1)
    expect(corpo.data.fallite).toHaveLength(0)
  })
})
