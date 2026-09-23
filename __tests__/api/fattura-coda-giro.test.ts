// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * LA PORTA DEL LAVORATORE DELLA CODA — il segreto del cron, e il battito in ogni esito.
 *
 * Il giro vero è collaudato in `__tests__/lib/fatture-coda/giro.test.ts`; qui è finto,
 * perché ciò che si misura è la route: chi entra, cosa risponde, e che il battito del job
 * `fatture-coda-tick` esca SEMPRE — anche quando non c'è niente da fare, che è il caso
 * normale e l'unico in cui l'assenza del battito direbbe «il cron non parte più».
 */

const h = vi.hoisted(() => ({
  giro: vi.fn(),
  admin: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; errore: unknown }[],
}))

vi.mock('@/lib/fatture-coda/giro', () => ({ eseguiGiroCoda: h.giro }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: h.admin }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, errore?: unknown) => {
      h.eventi.push({ evento, livello, campi, errore })
    },
  }
})

import { POST, maxDuration } from '@/app/api/pagamenti/fattura/coda/giro/route'
import { MAX_DURATION_BLOCCO_S } from '@/lib/pagamenti/lotto-fatture'

const URL_GIRO = 'http://localhost/api/pagamenti/fattura/coda/giro'
const SEGRETO = 'segreto-di-prova'
const CLIENT_FINTO = { finto: true }

function richiesta(headers: Record<string, string> = {}): Request {
  return new Request(URL_GIRO, { method: 'POST', headers })
}

const battiti = () => h.eventi.filter((e) => e.evento === 'cron' && e.campi.operazione === 'fatture-coda-tick')

beforeEach(() => {
  vi.clearAllMocks()
  h.eventi.length = 0
  vi.stubEnv('CRON_SECRET', SEGRETO)
  h.admin.mockResolvedValue(CLIENT_FINTO)
  h.giro.mockResolvedValue({ esito: 'niente-da-fare', emesse: 0, errori: 0, riprova: 0, pausaMinuti: 0 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('il segreto del cron', () => {
  it('senza header: 401, nessun giro, e nessuna riga d’errore (un `curl` anonimo non è un cron rotto)', async () => {
    const res = await POST(richiesta())

    expect(res.status).toBe(401)
    expect(h.giro).not.toHaveBeenCalled()
    expect(h.admin, 'nemmeno il client service role si apre').not.toHaveBeenCalled()
    expect(h.eventi.filter((e) => e.livello === 'error')).toEqual([])
  })

  it('header sbagliato: 401, e il log `secret-errato` di livello error', async () => {
    const res = await POST(richiesta({ 'x-cron-secret': 'sbagliato' }))

    expect(res.status).toBe(401)
    expect(h.giro).not.toHaveBeenCalled()
    const e = h.eventi.find((x) => x.campi.esito === 'secret-errato')
    expect(e?.evento).toBe('cron')
    expect(e?.livello).toBe('error')
    expect(e?.campi.operazione).toBe('fatture-coda-tick')
  })

  it('CRON_SECRET assente nell’ambiente: nessuno passa, nemmeno con un header vuoto', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const res = await POST(richiesta({ 'x-cron-secret': '' }))
    expect(res.status).toBe(401)
    expect(h.giro).not.toHaveBeenCalled()
  })
})

describe('il giro e il battito', () => {
  it('col segreto giusto il giro parte, col client service role', async () => {
    const res = await POST(richiesta({ 'x-cron-secret': SEGRETO }))

    expect(res.status).toBe(200)
    expect(h.giro).toHaveBeenCalledTimes(1)
    expect(h.giro.mock.calls[0][0]).toBe(CLIENT_FINTO)
  })

  it.each(['finestra-sync', 'quota-oraria', 'niente-da-fare'])(
    'esito «%s»: battito info con esito «ok», e il tipo del giro in `tipo`',
    async (esito) => {
      h.giro.mockResolvedValue({ esito, emesse: 0, errori: 0, riprova: 0, pausaMinuti: 0 })

      const res = await POST(richiesta({ 'x-cron-secret': SEGRETO }))

      expect(res.status).toBe(200)
      // La risposta HTTP parla il vocabolario del giro; il battito quello di `/api/health`.
      expect(await res.json()).toEqual({ ok: true, esito, emesse: 0, errori: 0, riprova: 0 })
      const b = battiti()
      expect(b).toHaveLength(1)
      expect(b[0].livello).toBe('info')
      expect(b[0].campi.esito).toBe('ok')
      expect(b[0].campi.tipo).toBe(esito)
      // Il nome del job e il tipo nel `msg`: l'impronta di `app_log` non guarda il contesto.
      expect(String(b[0].campi.msg)).toBe(`fatture-coda-tick: ${esito}`)
    },
  )

  it('esito «eseguito»: battito «ok» che porta i conteggi', async () => {
    h.giro.mockResolvedValue({ esito: 'eseguito', emesse: 12, errori: 1, riprova: 2, pausaMinuti: 15 })

    const res = await POST(richiesta({ 'x-cron-secret': SEGRETO }))

    expect(await res.json()).toEqual({ ok: true, esito: 'eseguito', emesse: 12, errori: 1, riprova: 2 })
    const [b] = battiti()
    expect(b.livello).toBe('info')
    expect(b.campi).toMatchObject({
      esito: 'ok',
      tipo: 'eseguito',
      emesse: 12,
      errori: 1,
      riprova: 2,
      pausa_minuti: 15,
    })
  })

  it.each(['finestra-sync', 'quota-oraria', 'niente-da-fare', 'eseguito'])(
    'esito «%s»: il battito è uno di quelli che `/api/health` conta come vivo',
    async (esito) => {
      // Si legge la costante VERA del controllo, non una copia: se un giorno `ESITI_BATTITO`
      // cambia, o il battito torna a scrivere l'esito del giro, questo test lo vede.
      const { ESITI_BATTITO } = await import('@/lib/health/controlli')
      h.giro.mockResolvedValue({ esito, emesse: 0, errori: 0, riprova: 0, pausaMinuti: 0 })

      await POST(richiesta({ 'x-cron-secret': SEGRETO }))

      const [b] = battiti()
      // Il controllo legge solo `info` e `warn` (vedi `controlloBattitoCron`).
      expect(['info', 'warn']).toContain(b.livello)
      expect(ESITI_BATTITO.has(String(b.campi.esito))).toBe(true)
    },
  )

  it('esito «errore»: 500, e il battito c’è lo stesso, di livello error e fuori da `ESITI_BATTITO`', async () => {
    const { ESITI_BATTITO } = await import('@/lib/health/controlli')
    h.giro.mockResolvedValue({ esito: 'errore', emesse: 0, errori: 0, riprova: 0, pausaMinuti: 0 })

    const res = await POST(richiesta({ 'x-cron-secret': SEGRETO }))

    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    const [b] = battiti()
    expect(b.livello).toBe('error')
    expect(b.campi.esito).toBe('errore')
    expect(b.campi.tipo).toBe('errore')
    // Un giro fallito NON deve contare come battito: il job muto deve restare muto.
    expect(ESITI_BATTITO.has(String(b.campi.esito))).toBe(false)
  })

  it('un’eccezione del giro non spegne il battito', async () => {
    const guasto = new Error('imprevisto')
    h.giro.mockRejectedValue(guasto)

    const res = await POST(richiesta({ 'x-cron-secret': SEGRETO }))

    expect(res.status).toBe(500)
    const [b] = battiti()
    expect(b.livello).toBe('error')
    expect(b.campi.esito).toBe('errore')
    expect(b.campi.tipo).toBe('errore')
    expect(b.errore).toBe(guasto)
  })
})

describe('`maxDuration`', () => {
  it('è 300 e LETTERALE nel sorgente, lo stesso muro su cui è tarato il budget del blocco', () => {
    // Next legge la configurazione di segmento staticamente: un valore importato fa fallire
    // il build. Il letterale e la costante vivono in due posti, e questo li tiene insieme.
    const sorgente = readFileSync(
      path.join(process.cwd(), 'src/app/api/pagamenti/fattura/coda/giro/route.ts'),
      'utf8',
    )
    expect(/^export const maxDuration = 300$/m.test(sorgente)).toBe(true)
    expect(maxDuration).toBe(MAX_DURATION_BLOCCO_S)
  })
})
