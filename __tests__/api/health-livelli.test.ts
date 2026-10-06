import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * I DUE ENDPOINT NUOVI DELLA FASE 3 — `/api/health/vivo` e `/api/health/qualita`.
 *
 * La salute completa (`/api/health`) ha i suoi test in `health.test.ts`. Qui si prova ciò che
 * distingue gli altri due livelli, e soprattutto ciò che NON devono fare:
 *
 *  · il VIVO risponde 503 solo se DB o Auth sono giù, e resta 200 `ok` con un cron fermo, una
 *    variabile sparita o i dati storti — è ciò che sorveglia un campanello, e un campanello che
 *    suona per un cron non è un campanello;
 *  · la QUALITÀ non risponde MAI 503: un dato storto non è un'interruzione di servizio, e non
 *    deve poter accendere nessun allarme.
 *
 * Ogni caso FORZA un guasto e pretende il verdetto giusto (come in `health.test.ts`).
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

const auth = vi.hoisted(() => ({ getUserById: vi.fn() }))

import { GET as GET_VIVO } from '@/app/api/health/vivo/route'
import { GET as GET_QUALITA } from '@/app/api/health/qualita/route'
import { GET as GET_SALUTE } from '@/app/api/health/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { VARIABILI_CRITICHE, type Salute } from '@/lib/health/controlli'

function authVivo() {
    return {
        data: { user: null },
        error: Object.assign(new Error('User not found'), { status: 404, code: 'user_not_found' }),
    }
}

function dbSano(): DBFinto {
    return {
        utenti: [{ id: 'u1' }],
        app_log: [],
        sections: [{ id: 's1', name: 'Sezione A' }],
        alunni: [{ id: 'a1', section_id: 's1', classe_sezione: 'Sezione A', stato: 'iscritto' }],
    }
}

function montaDb(db: DBFinto, errori: Record<string, ErrorePostgrest> = {}): void {
    const finto = creaFintoSupabase(db, [], { errori })
    supa.createAdminClient.mockResolvedValue(Object.assign(finto, { auth: { admin: { getUserById: auth.getUserById } } }))
}

async function chiama(GET: (r: Request) => Promise<Response>, url: string, ip = '10.0.0.1') {
    const res = await GET(new Request(url, { headers: { 'x-forwarded-for': ip } }))
    const grezzo = await res.text()
    return { stato: res.status, header: res.headers.get('X-Kv-Salute'), grezzo, corpo: JSON.parse(grezzo) as Salute }
}

const vivo = (ip?: string) => chiama(GET_VIVO, 'https://app.kidville.it/api/health/vivo', ip)
const qualita = (ip?: string) => chiama(GET_QUALITA, 'https://app.kidville.it/api/health/qualita', ip)

beforeEach(() => {
    vi.clearAllMocks()
    resetRateLimit()
    auth.getUserById.mockResolvedValue(authVivo())
    vi.stubEnv('VERCEL_ENV', 'production')
    for (const nome of VARIABILI_CRITICHE) vi.stubEnv(nome, 'valore-di-prova')
    montaDb(dbSano())
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('GET /api/health/vivo', () => {
    it('con DB e Auth sani risponde 200 ok, con SOLO i due controlli del vivo', async () => {
        const { stato, header, corpo } = await vivo()

        expect(stato).toBe(200)
        expect(header).toBe('ok')
        expect(corpo.stato).toBe('ok')
        // Non solo lo stato aggregato: un controllo che sparisse (o uno in più che entrasse)
        // cambierebbe il significato del campanello senza che nessuno se ne accorga.
        expect(corpo.controlli.map((c) => c.nome).sort()).toEqual(['auth', 'db-lettura'])
    })

    it("con `utenti` illeggibile risponde 503 e dice QUALE controllo è caduto", async () => {
        montaDb(dbSano(), { utenti: { code: 'PGRST205', message: 'Could not find the table' } })

        const { stato, header, corpo } = await vivo()

        expect(stato).toBe(503)
        expect(header).toBe('down')
        expect(corpo.controlli.find((c) => c.nome === 'db-lettura')?.esito).toBe('giu')
    })

    it('con Auth che risponde 500 (database sano) risponde 503: il login non funziona', async () => {
        auth.getUserById.mockResolvedValue({
            data: { user: null },
            error: Object.assign(new Error('unexpected_failure'), { status: 500, code: 'unexpected_failure' }),
        })

        const { stato, corpo } = await vivo()

        expect(stato).toBe(503)
        expect(corpo.controlli.find((c) => c.nome === 'db-lettura')?.esito).toBe('ok')
        expect(corpo.controlli.find((c) => c.nome === 'auth')?.esito).toBe('giu')
    })

    it('con Auth irraggiungibile risponde 503, senza eccezioni non gestite', async () => {
        auth.getUserById.mockRejectedValue(new TypeError('fetch failed'))

        const { stato } = await vivo()

        expect(stato).toBe(503)
    })

    it('NON suona per ciò che non impedisce a nessuno di entrare: variabile sparita, cron muti, dati storti', async () => {
        vi.stubEnv('RESEND_API_KEY', '')
        const db = dbSano()
        db.alunni = [{ id: 'a1', section_id: 's1', classe_sezione: 'Sezione B', stato: 'iscritto' }]
        montaDb(db)

        const { stato, corpo } = await vivo()

        // La salute completa sarebbe `degraded` (config) e nessuno dei suoi controlli è nel vivo.
        expect(stato).toBe(200)
        expect(corpo.stato).toBe('ok')
    })

    it('risponde senza cache, e dichiara regione e versione solo quando ci sono', async () => {
        vi.stubEnv('VERCEL_REGION', 'dub1')
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '13d8806585d38aba1e81a93620dc502f85c92b31')

        const res = await GET_VIVO(new Request('https://app.kidville.it/api/health/vivo'))
        const corpo = (await res.json()) as Salute

        expect(res.headers.get('Cache-Control')).toBe('no-store')
        expect(corpo.regione).toBe('dub1')
        expect(corpo.versione).toBe('13d8806585d3')
    })

    it('se createAdminClient lancia (deploy nato rotto) risponde 503 down, e logga con lo stack', async () => {
        supa.createAdminClient.mockRejectedValue(new Error('SUPABASE_SERVICE_ROLE_KEY mancante'))

        const { stato, header, grezzo } = await vivo()

        expect(stato).toBe(503)
        expect(header).toBe('down')
        expect(log.logErrore).toHaveBeenCalledTimes(1)
        // Al mondo esce lo stato, non il messaggio dell'errore.
        expect(grezzo).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    })

    it('ha un tetto per IP proprio: 30 richieste passano, la 31ª riceve 429 senza toccare il DB', async () => {
        for (let i = 0; i < 30; i++) expect((await vivo('10.9.9.9')).stato).toBe(200)
        supa.createAdminClient.mockClear()

        const res = await GET_VIVO(
            new Request('https://app.kidville.it/api/health/vivo', { headers: { 'x-forwarded-for': '10.9.9.9' } }),
        )

        expect(res.status).toBe(429)
        expect(res.headers.get('Retry-After')).not.toBeNull()
        expect(supa.createAdminClient).not.toHaveBeenCalled()
    })

    it('il tetto del vivo è SEPARATO da quello della salute: un monitor sul vivo non toglie il passo agli altri', async () => {
        for (let i = 0; i < 30; i++) await chiama(GET_SALUTE, 'https://app.kidville.it/api/health', '10.8.8.8')

        expect((await vivo('10.8.8.8')).stato).toBe(200)
    })
})

describe('GET /api/health/qualita', () => {
    it('con i dati allineati risponde 200 ok', async () => {
        const { stato, corpo } = await qualita()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('ok')
        expect(corpo.controlli.map((c) => c.nome)).toEqual(['sezione-testo-allineato'])
    })

    it('con 2 alunni col testo diverso dal nome della sezione dice «degraded» MA risponde 200', async () => {
        const db = dbSano()
        db.alunni = [
            { id: 'a1', section_id: 's1', classe_sezione: 'Sezione B', stato: 'iscritto' },
            { id: 'a2', section_id: 's1', classe_sezione: 'Sezione C', stato: 'iscritto' },
            { id: 'a3', section_id: 's1', classe_sezione: 'Sezione A', stato: 'iscritto' },
        ]
        montaDb(db)

        const { stato, header, corpo, grezzo } = await qualita()

        // È la ragione per cui esiste il livello: un dato storto non è un'interruzione di servizio.
        expect(stato).toBe(200)
        expect(header).toBe('degraded')
        expect(corpo.stato).toBe('degraded')
        expect(corpo.controlli[0].dettaglio).toBe('2 alunni col testo classe divergente')
        // Esce un NUMERO: i nomi delle classi direbbero a chiunque come si chiamano le sezioni.
        expect(grezzo).not.toContain('Sezione')
    })

    it('un alunno con section_id nullo (orfano) non conta: è un\'altra misura', async () => {
        const db = dbSano()
        db.alunni = [{ id: 'a1', section_id: null, classe_sezione: 'Sezione B', stato: 'iscritto' }]
        montaDb(db)

        expect((await qualita()).corpo.stato).toBe('ok')
    })

    it('gli alunni non iscritti non contano', async () => {
        const db = dbSano()
        db.alunni = [{ id: 'a1', section_id: 's1', classe_sezione: 'Sezione B', stato: 'ritirato' }]
        montaDb(db)

        expect((await qualita()).corpo.stato).toBe('ok')
    })

    it('con la lettura di `sections` caduta NON dichiara «tutto allineato»: è degraded, col solo codice', async () => {
        montaDb(dbSano(), { sections: { code: '57014', message: 'canceling statement: valore segreto 12345' } })

        const { stato, corpo, grezzo } = await qualita()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(corpo.controlli[0].dettaglio).toContain('57014')
        expect(grezzo).not.toContain('valore segreto')
    })

    it('NON risponde mai 503, nemmeno se il controllo non riesce a girare', async () => {
        supa.createAdminClient.mockRejectedValue(new Error('SUPABASE_SERVICE_ROLE_KEY mancante'))

        const { stato, header } = await qualita()

        expect(stato).toBe(200)
        expect(header).toBe('down')
    })

    it('lo stato degraded si logga a livello info: non finisce in app_log a ogni chiamata', async () => {
        const db = dbSano()
        db.alunni = [{ id: 'a1', section_id: 's1', classe_sezione: 'Sezione B', stato: 'iscritto' }]
        montaDb(db)

        await qualita()

        // Il difetto che ha motivato la separazione: 64 righe `warn` «degraded: 2 alunni» scritte a
        // ogni chiamata a `/api/health`, nel canale in cui si cercano i guasti veri.
        // (il rate-limit scrive i suoi eventi `db`: qui interessano solo quelli dell'endpoint, `config`)
        const livelli = log.logEvento.mock.calls.filter((c) => c[0] === 'config').map((c) => c[1])
        expect(livelli).toEqual(['info'])
        expect(livelli).not.toContain('warn')
    })

    it('non usa Auth: la qualità dei dati non dipende da GoTrue', async () => {
        await qualita()

        expect(auth.getUserById).not.toHaveBeenCalled()
    })
})
