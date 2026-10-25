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
import { controlloCronEsiti, controlloEmail, controlloPush, controlloStorage, TETTO_CONTROLLO_MS } from '@/lib/health/controlli'
import { fcmConfigured } from '@/lib/push/native-push'
import { vapidConfigured } from '@/lib/push/web-push'
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

describe('storage', () => {
    function fintoStorage(list: ReturnType<typeof vi.fn>) {
        const from = vi.fn(() => ({ list }))
        return { from, list, storage: { from } }
    }

    it('il bucket privato risponde: ok, e la sonda non chiede nomi di file', async () => {
        const s = fintoStorage(vi.fn().mockResolvedValue({ data: [], error: null }))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({
            nome: 'storage',
            esito: 'ok',
            dettaglio: 'bucket fatture leggibile',
        })
        expect(s.from).toHaveBeenCalledWith('fatture')
        expect(s.list).toHaveBeenCalledWith('salute-sonda-inesistente', { limit: 1 })
    })

    it.each([
        ['un 503', Object.assign(new Error('x'), { name: 'StorageApiError', status: 503 }), 'storage fatture: 503 StorageApiError'],
        [
            'un bucket sparito',
            Object.assign(new Error('x'), { name: 'StorageApiError', status: 400, code: 'NoSuchBucket' }),
            'storage fatture: 400 NoSuchBucket',
        ],
        [
            'un errore senza stato',
            Object.assign(new Error('x'), { name: 'StorageUnknownError' }),
            'storage fatture: senza-stato StorageUnknownError',
        ],
    ])('%s: degradato, con stato e codice e senza il messaggio', async (_caso, error, dettaglio) => {
        const s = fintoStorage(vi.fn().mockResolvedValue({ data: null, error }))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({ esito: 'degradato', dettaglio })
    })

    it('una list che lancia: degradato, con il nome dell’eccezione', async () => {
        const s = fintoStorage(vi.fn().mockRejectedValue(new TypeError('fetch failed')))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({
            esito: 'degradato',
            dettaglio: 'eccezione TypeError',
        })
    })

    // Fuori dal piano, aggiunti al mutation testing: la sonda è una LETTURA (una `list`), non scrive
    // nessun oggetto e quindi non ha niente da ripulire; il finto storage espone SOLO `list`, così un
    // `upload`/`remove` aggiunto per sbaglio lancerebbe e il caso sano qui sopra diventerebbe rosso.
    // Questi due fissano il resto: il tetto di tempo e il «mai giu».
    it('una list appesa: allo scadere del tetto di 2 s degradato, mai giu', async () => {
        vi.useFakeTimers()
        try {
            const s = fintoStorage(vi.fn(() => new Promise(() => {})))
            const p = controlloStorage(client({ storage: s.storage }))
            await vi.advanceTimersByTimeAsync(TETTO_CONTROLLO_MS)

            expect(await p).toMatchObject({ esito: 'degradato', dettaglio: `oltre il tetto di ${TETTO_CONTROLLO_MS} ms` })
        } finally {
            vi.useRealTimers()
        }
    })

    it('il messaggio dello Storage non esce mai nel dettaglio (può citare un percorso)', async () => {
        const error = Object.assign(new Error('fatture/2026/percorso-da-non-rilanciare.pdf'), {
            name: 'StorageApiError',
            status: 404,
        })
        const s = fintoStorage(vi.fn().mockResolvedValue({ data: null, error }))

        const r = await controlloStorage(client({ storage: s.storage }))

        expect(r).toMatchObject({ esito: 'degradato', dettaglio: 'storage fatture: 404 StorageApiError' })
        expect(JSON.stringify(r)).not.toContain('percorso-da-non-rilanciare')
    })
})

/** Una riga di `app_log` come la scrive `externalFetch`; `operazione` in cima è la colonna che la
 *  `select` ottiene con l'alias `operazione:contesto->campi->>operazione`. */
function esito(
    evento: string,
    provider: string,
    livello: string,
    stato: number | null,
    occorrenze: number,
    faMs: number,
    extra: Riga = {},
): Riga {
    return {
        evento,
        livello,
        sorgente: 'server',
        ambiente: 'production',
        stato_http: stato,
        occorrenze,
        visto_l_ultima: fa(faMs),
        operazione: 'invio',
        contesto: { campi: { provider, operazione: 'invio' } },
        ...extra,
    }
}

describe('email', () => {
    // Righe che la lettura deve ignorare, ciascuna da 50: se una entrasse nel conteggio,
    // ogni caso qui sotto cambierebbe esito.
    const RUMORE: Riga[] = [
        esito('email', 'resend', 'warn', 429, 50, 10 * MIN),
        esito('email', 'fcm', 'error', 500, 50, 10 * MIN),
        esito('email', 'resend', 'error', 403, 50, 25 * ORA),
        esito('email', 'resend', 'error', 403, 50, 10 * MIN, { ambiente: 'preview' }),
        esito('email', 'resend', 'error', 403, 50, 10 * MIN, { sorgente: 'client' }),
        esito('push', 'resend', 'error', 403, 50, 10 * MIN),
    ]

    it.each([
        { riusciti: 0, rifiuti: 3, atteso: 'degradato' }, // soglia
        { riusciti: 0, rifiuti: 2, atteso: 'ok' }, // soglia
        { riusciti: 5, rifiuti: 6, atteso: 'degradato' },
        { riusciti: 6, rifiuti: 6, atteso: 'ok' },
        { riusciti: 40, rifiuti: 2, atteso: 'ok' },
    ])('$riusciti riusciti e $rifiuti rifiutati nelle ultime 24 h → $atteso', async ({ riusciti, rifiuti, atteso }) => {
        const app_log = [...RUMORE]
        if (riusciti > 0) app_log.push(esito('email', 'resend', 'info', 200, riusciti, 10 * MIN))
        if (rifiuti > 0) app_log.push(esito('email', 'resend', 'error', 403, rifiuti, 20 * MIN))

        expect(await controlloEmail(client({ db: { app_log } }), ADESSO, 'production')).toMatchObject({
            nome: 'email',
            esito: atteso,
            dettaglio: `resend nelle ultime 24 h: ${riusciti} riusciti, ${rifiuti} rifiutati, ${
                riusciti > 0 ? 'ultimo riuscito 10 min fa' : 'nessuno riuscito'
            }`,
        })
    })

    it('nessun invio: ok', async () => {
        expect(await controlloEmail(client({ db: { app_log: [...RUMORE] } }), ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: 'resend: nessun invio nelle ultime 24 h',
        })
    })

    it('app_log illeggibile: degradato, con il codice', async () => {
        const c = client({ db: { app_log: [] }, errori: { app_log: { code: '57014', message: 'x' } } })

        expect(await controlloEmail(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'lettura esiti resend 57014',
        })
    })

    // Fuori dal piano, aggiunto al mutation testing: senza, un `misura('email', 'giu', …)` restava
    // verde qui (il lock «mai giu» arriva al Compito 11).
    it('una lettura che lancia (rete): degradato con il nome dell’eccezione, mai giu', async () => {
        expect(await controlloEmail(clientCheLancia(), ADESSO, 'production')).toMatchObject({
            nome: 'email',
            esito: 'degradato',
            dettaglio: 'eccezione TypeError',
        })
    })
})

/** Un client la cui `from()` lancia, come `fetch` quando la rete non c'è. */
function clientCheLancia(): SupabaseClient {
    return Object.assign(client(), {
        from: () => {
            throw new TypeError('fetch failed')
        },
    }) as SupabaseClient
}

describe('push', () => {
    function configuraTutto(): void {
        for (const nome of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
            vi.stubEnv(nome, 'valore-di-prova')
        }
    }

    it('FCM respinto e web-push sano: degradato, e il dettaglio dice quale', async () => {
        configuraTutto()
        const app_log = [
            esito('push', 'fcm', 'error', 403, 4, 30 * MIN),
            esito('push', 'fcm', 'warn', 503, 100, 5 * MIN),
            esito('push', 'fcm', 'info', 200, 50, 5 * MIN, {
                operazione: 'oauth-token',
                contesto: { campi: { provider: 'fcm', operazione: 'oauth-token' } },
            }),
            esito('push', 'web-push', 'info', 201, 3, 5 * MIN),
            esito('push', 'web-push', 'info', 410, 30, 5 * MIN),
        ]

        expect(await controlloPush(client({ db: { app_log } }), ADESSO, 'production')).toMatchObject({
            nome: 'push',
            esito: 'degradato',
            dettaglio:
                'fcm nelle ultime 24 h: 0 riusciti, 4 rifiutati, nessuno riuscito; ' +
                'web-push nelle ultime 24 h: 3 riusciti, 0 rifiutati, ultimo riuscito 5 min fa',
        })
    })

    it('FCM non configurato: lo dice, non lo legge, e resta ok (lo segnala già config)', async () => {
        configuraTutto()
        vi.stubEnv('FCM_PRIVATE_KEY', '')

        expect(await controlloPush(client({ db: { app_log: [] } }), ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: 'fcm non configurato (vedi config); web-push: nessun invio nelle ultime 24 h',
        })
    })

    it('app_log illeggibile: degradato, per ogni canale', async () => {
        configuraTutto()
        const c = client({ db: { app_log: [] }, errori: { app_log: { code: '57014', message: 'x' } } })

        expect(await controlloPush(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'lettura esiti fcm 57014; lettura esiti web-push 57014',
        })
    })

    // Fuori dal piano, aggiunto al mutation testing: senza, un `misura('push', 'giu', …)` restava
    // verde qui (il lock «mai giu» arriva al Compito 11).
    it('una lettura che lancia (rete): degradato con il nome dell’eccezione, mai giu', async () => {
        configuraTutto()

        expect(await controlloPush(clientCheLancia(), ADESSO, 'production')).toMatchObject({
            nome: 'push',
            esito: 'degradato',
            dettaglio: 'eccezione TypeError',
        })
    })

    it.each([
        { fcm: true, vapid: true },
        { fcm: false, vapid: true },
        { fcm: true, vapid: false },
        { fcm: false, vapid: false },
    ])('la stessa regola di fcmConfigured() e vapidConfigured(): fcm $fcm, vapid $vapid', async ({ fcm, vapid }) => {
        configuraTutto()
        if (!fcm) vi.stubEnv('FCM_CLIENT_EMAIL', '')
        if (!vapid) vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '')

        const { dettaglio } = await controlloPush(client({ db: { app_log: [] } }), ADESSO, 'production')

        expect(fcmConfigured()).toBe(fcm)
        expect(vapidConfigured()).toBe(vapid)
        expect(dettaglio?.includes('fcm non configurato')).toBe(!fcm)
        expect(dettaglio?.includes('web-push non configurato')).toBe(!vapid)
    })
})
