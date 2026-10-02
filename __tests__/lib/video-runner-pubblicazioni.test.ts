import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// LE PUBBLICAZIONI DEL RUNNER (PR 2, T7) — il punto d'aggancio `DipendenzeRunner.pubblicazioni`.
//
// `esegui.ts` sa solo QUANDO chiamarlo (lo prova `video-runner-orchestrazione.test.ts`); che cosa ci sia
// dentro lo decide `index.ts`: consumare `gallery.auto_publish` e scansionare gli esiti di conversione,
// DENTRO il tempo che resta e restando breve (secondario #105). Nel giro SENZA `job_id` le pubblicazioni
// girano prima di riprendere il job sorvegliato, e mentre girano nessuno batte per lui: un minuto al
// massimo, e mai oltre `restanteMs`.
//
// Il consumo (`consumaOutbox`) e la scansione (`scansionaEsitiDiConversione`) hanno i loro collaudi: qui
// sono due doppi che registrano le chiamate e FANNO AVANZARE un orologio finto, così il conto del tempo si
// prova su numeri e non su `setTimeout`. Il cablaggio col client vero lo prova `video-runner-tick.test.ts`.
// =============================================================================

const h = vi.hoisted(() => ({
  /** L'orologio finto, in millisecondi. */
  ora: 0,
  /** Quanto costa ogni consumo e ogni scansione. */
  costoConsumo: 0,
  costoScansione: 0,
  /** Quanti eventi prende ciascun consumo, in sequenza (finiti, la coda è vuota). */
  presi: [] as number[],
  consumi: [] as { opzioni: Record<string, unknown>; ora: number }[],
  scansioni: [] as { opzioni: Record<string, unknown>; ora: number }[],
  sequenza: [] as string[],
  esitoScansione: { esito: 'ok', candidati: 0, notificati: 0 } as { esito: string; candidati: number; notificati: number },
  log: vi.fn(),
}))

vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/media/video/outbox', async (originale) => ({
  ...(await originale<typeof import('@/lib/media/video/outbox')>()),
  consumaOutbox: async (_supabase: unknown, opzioni: Record<string, unknown>) => {
    h.consumi.push({ opzioni, ora: h.ora })
    h.sequenza.push('consumo')
    h.ora += h.costoConsumo
    const presi = h.presi.shift() ?? 0
    return { esito: 'ok', presi, inviati: presi, falliti: 0, senzaDestinatario: 0, saltati: 0 }
  },
}))
vi.mock('@/lib/media/video/esiti', async (originale) => ({
  ...(await originale<typeof import('@/lib/media/video/esiti')>()),
  scansionaEsitiDiConversione: async (_supabase: unknown, opzioni: Record<string, unknown>) => {
    h.scansioni.push({ opzioni, ora: h.ora })
    h.sequenza.push('scansione')
    h.ora += h.costoScansione
    return h.esitoScansione
  },
}))

import {
  eseguiLePubblicazioni,
  PUBBLICAZIONI_PER_CHIAMATA,
  STIMA_PUBBLICAZIONE_MS,
  STIMA_SCANSIONE_ESITI_MS,
  TETTO_PUBBLICAZIONI_MS,
} from '@/lib/media/video/runner'

const SUPABASE = {} as never
const adesso = () => h.ora

const SECONDO = 1000

beforeEach(() => {
  h.ora = 1_000_000
  h.costoConsumo = 0
  h.costoScansione = 0
  h.presi = []
  h.consumi = []
  h.scansioni = []
  h.sequenza = []
  h.esitoScansione = { esito: 'ok', candidati: 0, notificati: 0 }
  h.log.mockClear()
})

const esegui = (restanteMs: number, quando: 'giro' | 'dopo-esito' = 'giro') =>
  eseguiLePubblicazioni(SUPABASE, { quando, restanteMs }, { adesso })

describe('le costanti: numeri dichiarati, e il tetto sta SOTTO la lease di un job sorvegliato', () => {
  it('cinque pubblicazioni per chiamata, un minuto di tetto, una stima per pubblicazione e una per la scansione', () => {
    expect(PUBBLICAZIONI_PER_CHIAMATA).toBe(5)
    expect(TETTO_PUBBLICAZIONI_MS).toBe(60 * SECONDO)
    expect(STIMA_PUBBLICAZIONE_MS).toBe(15 * SECONDO)
    expect(STIMA_SCANSIONE_ESITI_MS).toBe(5 * SECONDO)
  })

  it('il tetto è ben dentro la lease di una conversione (300 s dall’ultimo battito): il job sorvegliato non la perde', async () => {
    const { SECONDI_LEASE_BATTITO } = await import('@/lib/media/video/runner')
    expect(TETTO_PUBBLICAZIONI_MS / 1000).toBeLessThan(SECONDI_LEASE_BATTITO / 2)
  })
})

describe('il consumo: UN evento alla volta, e solo i tipi del runner', () => {
  it('prende un evento per volta finché la coda non è vuota, sempre con lo stesso filtro nel claim', async () => {
    h.presi = [1, 1, 0]

    const esito = await esegui(240 * SECONDO)

    expect(h.consumi).toHaveLength(3)
    for (const c of h.consumi) {
      expect(c.opzioni).toEqual({
        operazione: 'video-runner',
        limite: 1,
        tipi: ['gallery.auto_publish'],
        leaseSecondi: 120,
      })
    }
    expect(esito.consumate).toBe(2)
    expect(esito.rimandate).toBe(false)
  })

  it('a coda vuota fa UN claim solo, non cinque', async () => {
    await esegui(240 * SECONDO)

    expect(h.consumi).toHaveLength(1)
  })

  it('al massimo cinque pubblicazioni per chiamata: il resto è del giro dopo', async () => {
    h.presi = Array.from({ length: 12 }, () => 1)

    const esito = await esegui(240 * SECONDO)

    expect(h.consumi).toHaveLength(PUBBLICAZIONI_PER_CHIAMATA)
    expect(esito.consumate).toBe(5)
  })

  it('il filtro è la lista dei tipi che SPETTANO al runner, non un elenco scritto qui', async () => {
    const { TIPI_SOLO_DEL_RUNNER } = await import('@/lib/media/video/outbox')

    await esegui(240 * SECONDO)

    expect(h.consumi[0].opzioni.tipi).toBe(TIPI_SOLO_DEL_RUNNER)
  })
})

describe('il tempo (#105): dentro `restanteMs`, e breve', () => {
  it('con 30 s a disposizione e 20 s per pubblicazione ne parte UNA: della seconda resterebbero 10 s, meno della stima', async () => {
    h.costoConsumo = 20 * SECONDO
    h.presi = [1, 1, 1]

    const esito = await esegui(30 * SECONDO)

    expect(h.consumi).toHaveLength(1)
    expect(esito).toMatchObject({ consumate: 1, rimandate: true })
  })

  it('anche con 240 s a disposizione il tetto è UN MINUTO: il job sorvegliato non batte durante le pubblicazioni', async () => {
    h.costoConsumo = 25 * SECONDO
    h.presi = Array.from({ length: 5 }, () => 1)

    const esito = await esegui(240 * SECONDO)

    // t=0: restano 60 s → parte; t=25: 35 → parte; t=50: 10 < 15 → si ferma. Mai oltre il minuto + una pubblicazione.
    expect(h.consumi.map((c) => c.ora - 1_000_000)).toEqual([0, 25 * SECONDO])
    expect(esito.consumate).toBe(2)
    expect(esito.rimandate).toBe(true)
  })

  it('senza tempo (`restanteMs` 0) NON si fa nemmeno il claim: nessun tentativo bruciato, e si dice che si è rimandato', async () => {
    const esito = await esegui(0, 'dopo-esito')

    expect(h.consumi).toEqual([])
    expect(h.scansioni).toEqual([])
    expect(esito).toEqual({ consumate: 0, rimandate: true, scansione: null })
    const riga = h.log.mock.calls.find((c) => (c[2] as Record<string, unknown>).esito === 'pubblicazioni-rimandate')
    expect(riga?.[0]).toBe('cron')
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ operazione: 'video-runner', azione: 'dopo-esito', n_pubblicazioni: 0, restante_ms: 0 })
  })

  it('un `restanteMs` negativo (non dovrebbe succedere) vale zero', async () => {
    const esito = await esegui(-5 * SECONDO)

    expect(h.consumi).toEqual([])
    expect(esito.consumate).toBe(0)
  })

  it('quando basta il tempo per una pubblicazione non scrive la riga «rimandate»', async () => {
    await esegui(240 * SECONDO)

    expect(h.log.mock.calls.some((c) => (c[2] as Record<string, unknown>).esito === 'pubblicazioni-rimandate')).toBe(false)
  })
})

describe('la scansione degli esiti di conversione', () => {
  it('gira DOPO le pubblicazioni, col nome del runner, e il suo esito torna a chi chiama', async () => {
    h.presi = [1, 0]
    h.esitoScansione = { esito: 'ok', candidati: 2, notificati: 2 }

    const esito = await esegui(240 * SECONDO)

    expect(h.sequenza).toEqual(['consumo', 'consumo', 'scansione'])
    expect(h.scansioni[0].opzioni).toEqual({ operazione: 'video-runner' })
    expect(esito.scansione).toEqual({ esito: 'ok', candidati: 2, notificati: 2 })
  })

  it('gira anche quando le pubblicazioni sono state tutte consumate: subito dopo un esito definitivo (`dopo-esito`) la notifica non aspetta il cron', async () => {
    h.presi = Array.from({ length: 5 }, () => 1)

    await esegui(240 * SECONDO, 'dopo-esito')

    expect(h.sequenza.at(-1)).toBe('scansione')
    expect(h.scansioni).toHaveLength(1)
  })

  it('si salta se non resta nemmeno il tempo per lei, e lo dice', async () => {
    h.costoConsumo = 56 * SECONDO
    h.presi = [1]

    // 60 s di budget: la pubblicazione ne costa 56, restano 4 < 5.
    const esito = await esegui(60 * SECONDO)

    expect(h.scansioni).toEqual([])
    expect(esito).toMatchObject({ consumate: 1, rimandate: true, scansione: null })
  })

  it('con esattamente il tempo stimato per la scansione, parte', async () => {
    h.costoConsumo = 55 * SECONDO
    h.presi = [1]

    const esito = await esegui(60 * SECONDO)

    expect(h.scansioni).toHaveLength(1)
    expect(esito.scansione).not.toBeNull()
  })
})
