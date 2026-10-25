// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
    creaFintoSupabase,
    type DBFinto,
    type ErrorePostgrest,
    type RispostaRpc,
    type Riga,
} from '../../fixtures/finto-supabase'
import { controlloCronEsiti, TETTO_CONTROLLO_MS } from '@/lib/health/controlli'
import { logEvento } from '@/lib/logging/logger'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * I CONTROLLI DELLA SESSIONE 7 (seconda serie di robustezza), UNO PER UNO, CON IL FINTO CLIENT.
 *
 * Per ognuno il caso sano e ogni «no» con numeri letterali. Mai `giu`: lo pretende anche il lock
 * `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts`.
 */

const MIN = 60_000
const ORA = 60 * MIN
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function fa(ms: number): string {
    return new Date(ADESSO - ms).toISOString()
}

interface Montaggio {
    db?: DBFinto
    errori?: Record<string, ErrorePostgrest>
    rpc?: Record<string, (args: Riga) => RispostaRpc | Promise<RispostaRpc>>
    storage?: unknown
}

function client({ db = {}, errori = {}, rpc = {}, storage }: Montaggio = {}): SupabaseClient {
    const finto = creaFintoSupabase(db, [], { errori, rpc })
    return (storage === undefined ? finto : Object.assign(finto, { storage })) as SupabaseClient
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('cron-esiti', () => {
    const SANO = [
        { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: fa(MIN), vivo_il: fa(MIN) },
        { job: 'notifiche-retention', cadenza: '35 4 1 * *', esito: 'ok', visto_il: fa(19 * 24 * ORA), vivo_il: fa(19 * 24 * ORA) },
    ]

    it('tutti dentro la finestra: ok, con il numero dei job attivi', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: SANO, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ nome: 'cron-esiti', esito: 'ok', dettaglio: '2 job attivi' })
    })

    it('un mensile senza esito buono da 32 giorni: degradato, e il job è nominato', async () => {
        const righe = [SANO[0], { ...SANO[1], esito: 'fallito', visto_il: fa(2 * ORA), vivo_il: fa(32 * 24 * ORA) }]
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: righe, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: notifiche-retention',
        })
    })

    it('la RPC non ancora nella cache di PostgREST, 10 minuti dopo la build: ok, e lo dice', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(10 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'ok',
            dettaglio: 'salute_cron_esiti non ancora installata (PGRST202)',
        })
        // §5 della specifica: chi regge una RPC nuova lo dice con una riga `info`, e perché.
        // `rpc` non è in EVENTI_PERSISTITI: la riga va nei log di Vercel, non in app_log.
        expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
            'rpc',
            'info',
            expect.objectContaining({ operazione: 'health:salute_cron_esiti', esito: 'rpc-non-ancora-installata' }),
        )
    })

    it('42883 (Postgres: «undefined function») è la stessa assenza vista dal database', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(5 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: '42883', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'ok',
            dettaglio: 'salute_cron_esiti non ancora installata (42883)',
        })
    })

    it('PGRST203 (due funzioni con lo stesso nome) NON è un’assenza: degradato subito', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST203', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'lettura esiti dei cron PGRST203' })
    })

    it('la stessa assenza 31 minuti dopo la build: degradato', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(31 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'salute_cron_esiti assente da oltre 30 min dalla build (PGRST202)',
        })
    })

    it('le tabelle di pg_cron o della sessione 6 assenti (P0001): degradato subito, anche appena dopo la build', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'P0001', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'lettura esiti dei cron P0001' })
    })

    it('una risposta che non ha la forma attesa: degradato', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: { job: 'x' }, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'risposta di salute_cron_esiti illeggibile',
        })
    })

    it('nessun job attivo letto: degradato', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: [], error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'nessun job attivo letto da cron.job',
        })
    })

    // Fuori dal piano, aggiunti al mutation testing: senza, un `misura('cron-esiti', 'giu', …)` o un
    // tetto di tempo tolto restavano verdi qui (il lock «mai giu» arriva al Compito 11).
    it('una RPC che lancia (rete): degradato con il nome dell’eccezione, mai giu', async () => {
        const c = client({
            rpc: {
                salute_cron_esiti: () => {
                    throw new TypeError('fetch failed')
                },
            },
        })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'eccezione TypeError' })
    })

    it('una RPC appesa: allo scadere del tetto di 2 s degradato, mai giu', async () => {
        vi.useFakeTimers()
        try {
            const c = client({ rpc: { salute_cron_esiti: () => new Promise<RispostaRpc>(() => {}) } })
            const p = controlloCronEsiti(c, ADESSO)
            await vi.advanceTimersByTimeAsync(TETTO_CONTROLLO_MS)

            expect(await p).toMatchObject({ esito: 'degradato', dettaglio: `oltre il tetto di ${TETTO_CONTROLLO_MS} ms` })
        } finally {
            vi.useRealTimers()
        }
    })
})
