import { inspect } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RigaLog = {
  codice?: string
  contesto: { campi?: Record<string, unknown>; operazione?: string; payload?: unknown }
  evento: string
  fingerprint: string
  livello: string
  messaggio: string
  request_id: string
  stack?: string
}

const h = vi.hoisted(() => ({
  apriRegistro: vi.fn(),
  rpc: vi.fn<(nome: string, args: { righe: RigaLog[] }) => Promise<{ error: null }>>()
    .mockResolvedValue({ error: null }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createLogClient: async () => {
    h.apriRegistro()
    return { rpc: h.rpc }
  },
}))

const SEDE = 'f0000000-0000-4000-8000-000000000001'
const VISITA = {
  scuolaId: SEDE,
  appuntamentoId: 'f0000000-0000-4000-8000-000000000002',
  destinatario: 'f0000000-0000-4000-8000-000000000003',
  inizio: '2026-12-02T09:00:00.000Z',
}
const TRACCE = {
  message: 'SentinellaMessaggio',
  details: 'SentinellaDettaglio',
  hint: 'SentinellaSuggerimento',
  cause: 'SentinellaCausa',
  stack: 'SentinellaStack',
  name: 'SentinellaNome',
  digest: 'SentinellaDigest',
  code: 'SentinellaCodice',
  campo: 'SentinellaCampo',
  rid: 'SentinellaRid',
  payload: 'SentinellaPayload',
}

function guastoDb(code = '23503') {
  return {
    code, message: TRACCE.message, details: TRACCE.details, hint: TRACCE.hint,
    name: TRACCE.name, digest: TRACCE.digest, stack: 'Error\n    at ' + TRACCE.stack,
    cause: new Error(TRACCE.cause),
  }
}

function guastoAvvolto() {
  return Object.assign(new Error(TRACCE.message), {
    ...guastoDb(TRACCE.code), cause: { ...guastoDb('XX000'), message: TRACCE.cause },
  })
}

function fintoDb({
  config = async () => ({ data: { notifiche_config: { toggles: {} } }, error: null as unknown }),
  insert = async () => ({ error: null as unknown }),
}: {
  config?: () => Promise<{ data: unknown; error: unknown }>
  insert?: (rows: Record<string, unknown>[]) => Promise<{ error: unknown }>
} = {}) {
  const leggiConfig = vi.fn(config)
  const accoda = vi.fn(insert)
  const client = {
    from(tabella: string) {
      if (tabella === 'admin_settings') {
        return { select: () => ({ eq: () => ({ maybeSingle: leggiConfig }) }) }
      }
      if (tabella === 'notifiche') return { insert: accoda }
      throw new Error('Tabella non prevista dal test: ' + tabella)
    },
  }
  return { client: client as unknown as SupabaseClient, leggiConfig, accoda }
}

let info: ReturnType<typeof vi.spyOn>
let errori: ReturnType<typeof vi.spyOn>
let rete: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  info = vi.spyOn(console, 'log').mockImplementation(() => {})
  errori = vi.spyOn(console, 'error').mockImplementation(() => {})
  rete = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rete non prevista dal test'))
})

afterEach(() => {
  const chiamateRete = rete.mock.calls.length
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  expect(chiamateRete).toBe(0)
})

function righeRegistro() {
  return h.rpc.mock.calls.flatMap(([nome, args]) => {
    expect(nome).toBe('app_log_registra')
    return args.righe
  })
}

function senzaTracce(...valori: unknown[]) {
  const uscita = inspect(valori, { depth: null, breakLength: Infinity })
  expect(Object.values(TRACCE).filter(traccia => uscita.includes(traccia))).toEqual([])
}

async function carica() {
  const [agenda, ctx, logger] = await Promise.all([
    import('@/lib/crm/agenda'),
    import('@/lib/logging/context'),
    import('@/lib/logging/logger'),
  ])
  function protetto(fn: () => void | Promise<void>, chiavi = false) {
    const path = chiavi ? '/api/admin/crm/integrazioni' : '/api/crm/ai/prenota'
    const rotta = chiavi ? 'admin/crm/integrazioni:POST' : 'crm/ai/prenota:POST'
    const request = new Request('https://test.invalid' + path, { headers: { 'x-request-id': TRACCE.rid } })
    return ctx.conContestoCrmAi(request, rotta, path, async () => {
      const rid = ctx.contesto()!.requestId
      expect(rid).not.toBe(TRACCE.rid)
      ctx.impostaPayload('body', { testo: TRACCE.payload, n: 19 })
      await fn()
      return rid
    })
  }
  return { ...agenda, ...ctx, ...logger, protetto }
}

describe('Log della notifica CRM AI, dalla visita al registro', () => {
  it('errore nella config: mantiene il warn e accoda una volta con il fail-open', async () => {
    const { protetto, notificaVisitaAssegnata } = await carica()
    const db = fintoDb({ config: async () => ({ data: null, error: guastoDb('PGRST205') }) })
    const rid = await protetto(() => notificaVisitaAssegnata(db.client, VISITA))
    expect(db.leggiConfig).toHaveBeenCalledOnce()
    expect(db.accoda).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(righeRegistro()).toHaveLength(1))
    senzaTracce(errori.mock.calls, info.mock.calls, righeRegistro())
    expect(errori.mock.calls).toEqual([[expect.stringContaining('KV_WARN rid=' + rid)]])
    expect(errori.mock.calls[0][0]).toContain('code=PGRST205')
    expect(righeRegistro()).toMatchObject([{
      evento: 'config', livello: 'warn', codice: 'PGRST205', request_id: rid,
      contesto: { campi: { operazione: 'getModuleConfig', esito: 'config-illeggibile-notifiche_config', scuola_id: SEDE } },
    }])
  })

  it.each([
    ['errore PostgREST', async () => ({ error: guastoDb() }), '23503', 'insert-fallito'],
    ['eccezione avvolta', async () => { throw guastoAvvolto() }, 'XX000', 'insert-non-eseguito'],
  ] as const)('%s durante l’insert: conserva il guasto e lascia fuori tutti i dettagli', async (_caso, insert, codice, esito) => {
    const { protetto, notificaVisitaAssegnata } = await carica()
    const db = fintoDb({ insert })
    const rid = await protetto(() => notificaVisitaAssegnata(db.client, VISITA))
    expect(db.accoda).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(righeRegistro()).toHaveLength(1))
    senzaTracce(errori.mock.calls, info.mock.calls, righeRegistro())
    expect(errori.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(errori.mock.calls.length).toBeLessThanOrEqual(2)
    expect(errori.mock.calls[0][0]).toContain('KV_ERR rid=' + rid)
    expect(errori.mock.calls[0][0]).toContain('code=' + codice)
    expect(righeRegistro()).toMatchObject([{
      evento: 'notifica', livello: 'error', codice, request_id: rid,
      contesto: { campi: { operazione: 'enqueueNotifiche', esito, tipo: 'crm_visita_assegnata', n: 1 } },
    }])
    expect(righeRegistro()[0].stack).toBeUndefined()
    expect(righeRegistro()[0].contesto).not.toHaveProperty('payload')
  })

  it('successo: una sola notifica alla persona assegnata e nessun guasto registrato', async () => {
    const { protetto, notificaVisitaAssegnata } = await carica()
    const db = fintoDb()
    await protetto(() => notificaVisitaAssegnata(db.client, VISITA))
    expect(db.accoda).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      utente_id: VISITA.destinatario, tipo: 'crm_visita_assegnata', entita_id: VISITA.appuntamentoId,
      titolo: 'Visita assegnata a te', link: '/admin/crm?tab=agenda',
    })])
    expect(errori).not.toHaveBeenCalled()
    expect(h.apriRegistro).not.toHaveBeenCalled()
  })

  it('non cambia i due contesti in concorrenza: logErrore preserva diagnosi ordinaria e codice protetto', async () => {
    const { protetto, conContesto, contesto, logErrore, impostaPayload, erroreGiaLoggato } = await carica()
    let arrivi = 0
    let libera!: () => void
    const barriera = new Promise<void>(resolve => { libera = resolve })
    async function attendiEntrambe() {
      if (++arrivi === 2) libera()
      await barriera
    }

    const [rid] = await Promise.all([
      protetto(async () => {
        await attendiEntrambe()
        expect(erroreGiaLoggato()).toBe(false)
        logErrore({ operazione: 'admin/crm/integrazioni:POST', stato: 500, ms: 4 }, guastoAvvolto())
        expect(erroreGiaLoggato()).toBe(true)
      }, true),
      conContesto({ requestId: 'ordinaria', path: '/api/prova' }, async () => {
        impostaPayload('body', { n: 17 })
        await attendiEntrambe()
        expect(erroreGiaLoggato()).toBe(false)
        logErrore({ operazione: 'prova-ordinaria' }, guastoAvvolto())
        expect(erroreGiaLoggato()).toBe(true)
      }),
    ])

    expect(contesto()).toBeUndefined()
    await vi.waitFor(() => expect(righeRegistro()).toHaveLength(2))
    const [privata, ordinaria] = [rid, 'ordinaria'].map(id => righeRegistro().find(r => r.request_id === id))
    const righeConsole: unknown[] = errori.mock.calls.map(([valore]: unknown[]) => valore)
    const iPrivata = righeConsole.findIndex(v => typeof v === 'string' && v.includes('rid=' + rid))
    const iOrdinaria = righeConsole.findIndex(v => typeof v === 'string' && v.includes('rid=ordinaria'))
    expect(iPrivata).toBeGreaterThanOrEqual(0)
    expect(iOrdinaria).toBeGreaterThanOrEqual(0)
    expect(righeConsole[iPrivata]).toContain('code=XX000')
    expect(righeConsole[iPrivata]).toContain('rt=admin/crm/integrazioni:POST')
    expect(righeConsole[iOrdinaria]).toContain(TRACCE.cause)
    expect(ordinaria?.messaggio).toContain(TRACCE.message)
    expect(ordinaria?.contesto).toHaveProperty('payload')
    expect(privata).toMatchObject({
      codice: 'XX000', stato_http: 500, contesto: { operazione: 'admin/crm/integrazioni:POST', ms: 4 },
    })
    senzaTracce(privata, righeConsole[iPrivata], iPrivata + 1 !== iOrdinaria ? righeConsole[iPrivata + 1] : undefined)
  })

  it('chiude anche i campi del chiamante, conserva solo il codice valido e rispetta persisti:false', async () => {
    const { protetto, logEvento } = await carica()
    const campi = {
      operazione: 'enqueueNotifiche', esito: 'insert-fallito', n: 0,
      msg: TRACCE.campo, details: TRACCE.details, hint: TRACCE.hint, digest: TRACCE.digest,
      stack: TRACCE.stack, cause: TRACCE.cause, error_code: TRACCE.code, code: TRACCE.code,
      payload: TRACCE.payload, rid: TRACCE.rid, uid: TRACCE.campo, testo: TRACCE.campo,
      tipo: TRACCE.campo, stato: TRACCE.campo, destinatario: TRACCE.campo,
    }
    const rid = await protetto(() => {
      logEvento('notifica', 'error', campi, guastoDb(TRACCE.code), { persisti: false })
    })
    expect(h.apriRegistro).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(errori.mock.calls[0][0]).toContain('KV_ERR rid=' + rid)
    expect(errori.mock.calls[0][0]).toContain('rt=enqueueNotifiche')
    expect(errori.mock.calls[0][0]).toContain('n=0')
    senzaTracce(errori.mock.calls, info.mock.calls)
    await protetto(() => {
      logEvento('notifica', 'warn', { ...campi, operazione: TRACCE.campo, esito: TRACCE.campo })
      logEvento('notifica', 'warn', { ...campi, error_code: '23503' })
    })
    await vi.waitFor(() => expect(righeRegistro()).toHaveLength(2))
    expect(righeRegistro()[0].codice).toBeUndefined()
    expect(righeRegistro()[1].codice).toBe('23503')
    senzaTracce(errori.mock.calls, info.mock.calls, righeRegistro())
  })

  it('impronta stabile per lo stesso guasto, distinta per operazione o esito tecnico', async () => {
    const { protetto, logEvento } = await carica()
    await protetto(() => {
      const scrivi = (operazione: string, esito: string, message: string) =>
        logEvento('notifica', 'error', { operazione, esito }, { ...guastoDb(), message })
      scrivi('enqueueNotifiche', 'insert-fallito', TRACCE.message)
      scrivi('enqueueNotifiche', 'insert-fallito', TRACCE.cause)
      scrivi('enqueueNotifiche', 'insert-non-eseguito', TRACCE.message)
      scrivi('notificaEvento', 'insert-fallito', TRACCE.message)
    })
    await vi.waitFor(() => expect(righeRegistro()).toHaveLength(4))
    const [prima, stessa, altroEsito, altraOperazione] = righeRegistro().map(r => r.fingerprint)
    expect(prima).toBe(stessa)
    expect(new Set([prima, altroEsito, altraOperazione]).size).toBe(3)
    senzaTracce(errori.mock.calls, info.mock.calls, righeRegistro())
  })
})
