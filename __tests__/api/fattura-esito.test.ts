import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const FATTURA = '20000000-0000-4000-8000-000000000002'
const SCUOLA = '30000000-0000-4000-8000-000000000003'
const ALUNNO = '40000000-0000-4000-8000-000000000004'
const UTENTE = '50000000-0000-4000-8000-000000000005'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  user: null as Riga | null,
  pagamento: null as Riga | null,
  fattura: null as Riga | null,
  errorePagamento: null as unknown,
  erroreFattura: null as unknown,
  scope: null as Response | null,
  visibile: true,
  erroreVisibilita: null as Response | null,
  filtri: [] as { tabella: string; colonna: string; valore: unknown }[],
  rateLimit: vi.fn(),
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: h.user })),
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: h.rateLimit }))
vi.mock('@/lib/pagamenti/scope-fattura', () => ({
  assertFatturaInScope: vi.fn(async () => h.scope),
}))
vi.mock('@/lib/pagamenti/visibilita-fatture', () => ({
  caricaVisibilitaFatture: vi.fn(async () => h.erroreVisibilita
    ? { esito: 'errore', response: h.erroreVisibilita }
    : { esito: 'ok', puoVedere: () => h.visibile }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = (colonna: string, valore: unknown) => {
        h.filtri.push({ tabella, colonna, valore })
        return query
      }
      query.maybeSingle = async () => {
        if (tabella === 'pagamenti') return { data: h.pagamento, error: h.errorePagamento }
        if (tabella === 'fatture_emesse') return { data: h.fattura, error: h.erroreFattura }
        return { data: null, error: null }
      }
      return query
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/fattura/esito/route'

function richiesta(body: unknown): Request {
  return new Request('http://test/api/pagamenti/fattura/esito', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const corpo = {
  pagamento_id: PAGAMENTO,
  fattura_id: FATTURA,
  esito: 'visualizzata',
}

const eventiFattura = () => log.logEvento.mock.calls.filter((chiamata) => chiamata[0] === 'fattura')

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: UTENTE, role: 'genitore', scuola_id: SCUOLA }
  h.pagamento = { id: PAGAMENTO, scuola_id: SCUOLA, alunno_id: ALUNNO }
  h.fattura = {
    id: FATTURA,
    pagamento_id: PAGAMENTO,
    scuola_id: SCUOLA,
    modalita_emissione: 'ordinaria',
    parent_registry_id: null,
  }
  h.errorePagamento = null
  h.erroreFattura = null
  h.scope = null
  h.visibile = true
  h.erroreVisibilita = null
  h.filtri = []
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 119, retryAfterMs: 0 })
})

describe('POST /api/pagamenti/fattura/esito', () => {
  it('registra un enum autorizzato con l’attore della sessione e risposta no-store', async () => {
    const res = await POST(richiesta(corpo))

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(h.rateLimit).toHaveBeenCalledWith(
      `fattura-esito:${UTENTE}`,
      { limit: 120, windowMs: 600_000 },
    )
    expect(h.filtri).toEqual(expect.arrayContaining([
      { tabella: 'fatture_emesse', colonna: 'id', valore: FATTURA },
      { tabella: 'fatture_emesse', colonna: 'pagamento_id', valore: PAGAMENTO },
      { tabella: 'fatture_emesse', colonna: 'scuola_id', valore: SCUOLA },
    ]))
    expect(log.logEvento).toHaveBeenCalledWith('fattura', 'info', {
      operazione: 'pagamenti/fattura/esito',
      esito: 'visualizzata',
      pagamento_id: PAGAMENTO,
      fattura_id: FATTURA,
      utente: UTENTE,
    })
  })

  it('rifiuta enum e campi estranei senza leggere dati o scrivere eventi', async () => {
    const enumNonValido = await POST(richiesta({ ...corpo, esito: 'file_salvato' }))
    expect(enumNonValido.status).toBe(400)

    const capability = await POST(richiesta({
      ...corpo,
      url: 'https://storage.test/fattura.pdf?token=segreto',
      testo: 'dato libero',
      attore: 'spoof',
    }))
    expect(capability.status).toBe(400)
    expect(h.filtri).toEqual([])
    expect(eventiFattura()).toEqual([])
  })

  it('ferma scope e visibilità negati senza emettere il successo', async () => {
    h.scope = NextResponse.json({ error: 'negato', codice: 'FATTURA_ACCESSO_NEGATO' }, { status: 403 })
    const fuoriScope = await POST(richiesta(corpo))
    expect(fuoriScope.status).toBe(403)
    expect(eventiFattura()).toEqual([])

    h.scope = null
    h.visibile = false
    const nonVisibile = await POST(richiesta(corpo))
    expect(nonVisibile.status).toBe(404)
    expect((await nonVisibile.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(eventiFattura()).toEqual([])
  })

  it('nega una fattura non appartenente a pagamento e sede senza fidarsi del body', async () => {
    h.fattura = null
    const res = await POST(richiesta(corpo))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(eventiFattura()).toEqual([])
  })

  it('risponde con codice catalogato agli errori di lettura', async () => {
    h.erroreFattura = { code: 'PGRST500' }
    const res = await POST(richiesta(corpo))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(eventiFattura()).toEqual([])
    expect(log.logErrore).toHaveBeenCalled()
  })

  it('applica il tetto per utente prima delle letture', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterMs: 9_100 })
    const res = await POST(richiesta(corpo))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('10')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(h.filtri).toEqual([])
    expect(eventiFattura()).toEqual([])
  })
})
