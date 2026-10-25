import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    MINUTI_BATTITO,
    ORIGINE,
    REPO,
    URL_VIVO,
    WORKFLOW,
    giro,
    leggiVivo,
    suonaCampanello,
} from '../../monitor-esterno/worker.mjs'
import { TITOLO_DA_FUORI, mandaEmail } from '../../scripts/campanello/allarme.mjs'

/**
 * IL MONITOR ESTERNO (Worker di Cloudflare), con un `fetch` finto. Ogni caso forza un guasto e
 * pretende il verdetto: il vivo giù fa partire il campanello SUBITO, il battito ogni quarto d'ora lo
 * fa partire comunque, un rifiuto di GitHub finisce nel log con il suo corpo.
 */

const DISPATCH = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`
type Risposta = { status: number; testo?: string } | Error

function fetchFinto(per: Record<string, Risposta[]>) {
    const chiamate: { url: string; verbo?: string; corpo?: string; auth?: string; idem?: string }[] = []
    const indice: Record<string, number> = {}
    const impl = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        chiamate.push({
            url,
            verbo: init?.method,
            corpo: init?.body,
            auth: init?.headers?.Authorization,
            idem: init?.headers?.['Idempotency-Key'],
        })
        const seq = per[url]
        if (!seq) throw new Error(`fetch finto: URL non previsto ${url}`)
        const i = Math.min(indice[url] ?? 0, seq.length - 1)
        indice[url] = (indice[url] ?? 0) + 1
        const r = seq[i]
        if (r instanceof Error) throw r
        return { status: r.status, text: async () => r.testo ?? '' }
    })
    return { impl: impl as unknown as typeof fetch, chiamate, a: (u: string) => chiamate.filter((c) => c.url === u) }
}

const OK = { status: 200, testo: '{"stato":"ok"}' }
const GIU = { status: 503, testo: '{"stato":"down"}' }
const PARTITO = { status: 204 }
// Le 10:05 non sono un quarto d'ora; le 10:15 sì.
const FUORI_BATTITO = new Date('2026-10-19T10:05:00Z')
const SUL_BATTITO = new Date('2026-10-19T10:15:00Z')
const RESEND = 'https://api.resend.com/emails'
const ACCETTATA = { status: 200, testo: '{"id":"e1"}' }
type Segreti = { chiaveResend?: string; destinatari?: string }
const SEGRETI: Segreti = { chiaveResend: 're_prova', destinatari: 'a@esempio.test,b@esempio.test' }

async function unGiro(f: ReturnType<typeof fetchFinto>, quando: Date, token = 'tok') {
    const dormi = vi.fn(async () => {})
    const log = vi.fn()
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    const esito = await giro({ quando, token, fetchImpl: f.impl, dormi, log })
    const righeErrore = errore.mock.calls.map((c) => String(c[0]))
    errore.mockRestore()
    return { esito, dormi, log, righeErrore }
}

describe('il monitor esterno', () => {
    it('il battito è ogni 15 minuti e il titolo che il campanello cerca è quello dell\'input', () => {
        expect(MINUTI_BATTITO).toBe(15)
        expect(ORIGINE).toBe('cloudflare')
        // Il `run-name` di campanello.yml traduce `origine=cloudflare` nel titolo che `giriDaFuori` filtra.
        const yml = readFileSync(join(process.cwd(), '.github/workflows/campanello.yml'), 'utf8')
        expect(yml).toContain(`inputs.origine == '${ORIGINE}' && ' ${TITOLO_DA_FUORI}'`)
    })

    it('vivo sano fuori dal battito: NON fa partire il campanello', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(0)
        expect(f.a(URL_VIVO)).toHaveLength(1)
    })

    it('vivo sano SUL battito: fa partire il campanello con origine=cloudflare su main', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK], [DISPATCH]: [PARTITO] })

        const { esito, log } = await unGiro(f, SUL_BATTITO)

        expect(esito.suonato).toBe(true)
        const corpo = JSON.parse(f.a(DISPATCH)[0].corpo!)
        expect(corpo).toEqual({ ref: 'main', inputs: { origine: 'cloudflare' } })
        expect(f.a(DISPATCH)[0].auth).toBe('Bearer tok')
        expect(String(log.mock.calls[0][0])).toContain('battito')
    })

    it('vivo giù due volte fuori dal battito: fa partire SUBITO il campanello, dopo 20 s di attesa fra i tentativi', async () => {
        const f = fetchFinto({ [URL_VIVO]: [GIU], [DISPATCH]: [PARTITO] })

        const { esito, dormi, log } = await unGiro(f, FUORI_BATTITO)

        expect(f.a(URL_VIVO)).toHaveLength(2)
        expect(dormi).toHaveBeenCalledWith(20_000)
        expect(esito.suonato).toBe(true)
        expect(String(log.mock.calls[0][0])).toContain('HTTP 503')
    })

    it('uno scatto isolato (503 poi 200) non sveglia nessuno', async () => {
        const f = fetchFinto({ [URL_VIVO]: [GIU, OK] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(0)
    })

    it('una rete che non risponde conta come vivo giù', async () => {
        const f = fetchFinto({ [URL_VIVO]: [new Error('timeout')], [DISPATCH]: [PARTITO] })

        const { esito } = await unGiro(f, FUORI_BATTITO)

        expect(esito.vivo.ok).toBe(false)
        expect(esito.vivo.http).toBeNull()
        expect(esito.suonato).toBe(true)
    })

    it('un rifiuto di GitHub finisce nel log CON il corpo (un 401 senza corpo non dice che il token è scaduto)', async () => {
        const f = fetchFinto({ [URL_VIVO]: [GIU], [DISPATCH]: [{ status: 401, testo: '{"message":"Bad credentials"}' }] })

        const { esito, righeErrore } = await unGiro(f, FUORI_BATTITO)

        expect(esito.suonato).toBe(false)
        expect(righeErrore.join(' ')).toMatch(/401.*Bad credentials/)
        expect(righeErrore.join(' ')).not.toContain('tok')
    })

    it('senza token non chiama GitHub e lo dice', async () => {
        const f = fetchFinto({ [URL_VIVO]: [GIU] })

        const { esito, righeErrore } = await unGiro(f, FUORI_BATTITO, '')

        expect(f.a(DISPATCH)).toHaveLength(0)
        expect(esito.suonato).toBe(false)
        expect(righeErrore.join(' ')).toContain('manca GITHUB_TOKEN_CAMPANELLO')
    })
})

describe('suonaCampanello', () => {
    it('se GitHub rifiuta l\'input (campanello.yml che non lo dichiara) riprova senza input', async () => {
        const f = fetchFinto({
            [DISPATCH]: [{ status: 422, testo: '{"message":"Unexpected inputs provided: [\\"origine\\"]"}' }, PARTITO],
        })

        const esito = await suonaCampanello({ token: 't', fetchImpl: f.impl })

        expect(esito.ok).toBe(true)
        expect(f.a(DISPATCH).map((c) => JSON.parse(c.corpo!))).toEqual([
            { ref: 'main', inputs: { origine: 'cloudflare' } },
            { ref: 'main' },
        ])
    })

    it('un altro 422 NON si ritenta senza input', async () => {
        const f = fetchFinto({ [DISPATCH]: [{ status: 422, testo: '{"message":"No ref found for: main"}' }] })

        const esito = await suonaCampanello({ token: 't', fetchImpl: f.impl })

        expect(esito.ok).toBe(false)
        expect(f.a(DISPATCH)).toHaveLength(1)
    })
})

describe('leggiVivo', () => {
    it('200 al primo tentativo: non aspetta e non ritenta', async () => {
        const f = fetchFinto({ [URL_VIVO]: [OK] })
        const dormi = vi.fn(async () => {})

        expect(await leggiVivo({ fetchImpl: f.impl, dormi })).toEqual({ ok: true, http: 200, motivo: 'ok' })
        expect(dormi).not.toHaveBeenCalled()
    })
})

describe('wrangler.toml', () => {
    const toml = readFileSync(join(process.cwd(), 'monitor-esterno/wrangler.toml'), 'utf8')

    it('ogni 5 minuti, nessun indirizzo pubblico, nessun segreto nel file', () => {
        expect(toml).toMatch(/^crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/m)
        expect(toml).toMatch(/^workers_dev\s*=\s*false\s*$/m)
        expect(toml).not.toMatch(/github_pat_|ghp_|\[vars\]/)
    })
})

describe('mandaEmail e la chiave di Resend', () => {
    const base = {
        chiaveResend: 're_prova',
        destinatari: 'a@esempio.test',
        oggetto: 'o',
        introHtml: 'i',
        link: 'https://esempio.test/giri',
        quando: 'q',
    }

    it('con la chiave manda Idempotency-Key; senza chiave non la manda (il campanello resta com\'è)', async () => {
        const f = fetchFinto({ [RESEND]: [ACCETTATA] })

        await mandaEmail({ ...base, chiaveIdempotenza: 'kidville-backup-non-partito-2026-10-21', fetchImpl: f.impl })
        await mandaEmail({ ...base, fetchImpl: f.impl })

        expect(f.a(RESEND).map((c) => c.idem)).toEqual(['kidville-backup-non-partito-2026-10-21', undefined])
    })
})
