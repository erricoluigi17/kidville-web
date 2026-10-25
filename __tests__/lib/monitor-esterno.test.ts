import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    LINK_GIRI_BACKUP,
    MINUTI_BATTITO,
    ORIGINE,
    REPO,
    URL_VIVO,
    WORKFLOW,
    WORKFLOW_BACKUP,
    chiaveIdempotenza,
    giro,
    giroBackup,
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
const WF_BACKUP = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
const DISPATCH_BACKUP = `${WF_BACKUP}/dispatches`
const ABILITA_BACKUP = `${WF_BACKUP}/enable`
const NOTTE = new Date('2026-10-21T02:23:00Z')
const TOKEN = 'ghtok-di-prova'
const SPENTO = { status: 422, testo: '{"message":"Cannot trigger a \'workflow_dispatch\' on a disabled workflow"}' }
const CREDENZIALI = { status: 401, testo: '{"message":"Bad credentials"}' }
/** Il mittente del campanello, letto dal suo sorgente: il Worker deve usare lo stesso. */
const MITTENTE_CAMPANELLO = /const MITTENTE = '([^']+)'/.exec(
    readFileSync(join(process.cwd(), 'scripts/campanello/allarme.mjs'), 'utf8'),
)?.[1]

async function unGiroBackup(f: ReturnType<typeof fetchFinto>, token = TOKEN, segreti: Segreti = SEGRETI) {
    const log = vi.fn()
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    const esito = await giroBackup({ quando: NOTTE, token, segreti, fetchImpl: f.impl, log })
    const righeErrore = errore.mock.calls.map((c) => String(c[0]))
    errore.mockRestore()
    return { esito, righe: log.mock.calls.map((c) => String(c[0])), righeErrore }
}

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

describe('il backup delle 02:23 (giroBackup)', () => {
    it('lancia backup-notturno.yml su main con modalita=completo e origine=cloudflare, e lo scrive', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [PARTITO] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toEqual({ ok: true, esito: 'partito', http: 204, corpo: '' })
        expect(JSON.parse(f.a(DISPATCH_BACKUP)[0].corpo!)).toEqual({
            ref: 'main',
            inputs: { modalita: 'completo', origine: 'cloudflare' },
        })
        expect(f.a(DISPATCH_BACKUP)[0].verbo).toBe('POST')
        expect(f.a(DISPATCH_BACKUP)[0].auth).toBe(`Bearer ${TOKEN}`)
        expect(righe.join(' ')).toContain('monitor-backup: esito=partito')
        expect(righeErrore).toEqual([])
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('workflow spento da GitHub per inattività: lo riattiva e riprova UNA volta, senza email', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO, PARTITO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 204 }],
        })

        const { esito, righe } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('riattivato-e-partito')
        expect(f.a(ABILITA_BACKUP).map((c) => c.verbo)).toEqual(['PUT'])
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(2)
        expect(righe.join(' ')).toContain('esito=riattivato-e-partito')
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('riattivato ma il secondo lancio è rifiutato: NON riprova una terza volta, e avvisa', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO, { status: 500, testo: '{"message":"Server Error"}' }],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 204 }],
            [RESEND]: [ACCETTATA],
        })

        const { esito, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: 500 })
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(2)
        expect(f.a(ABILITA_BACKUP)).toHaveLength(1)
        expect(righeErrore.join(' ')).toMatch(/riattivato, ma il lancio è stato rifiutato.*Server Error/)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('spento per inattività e riattivazione rifiutata: non rilancia, e avvisa col corpo del rifiuto', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
            [ABILITA_BACKUP]: [{ status: 403, testo: '{"message":"Resource not accessible by personal access token"}' }],
            [RESEND]: [ACCETTATA],
        })

        const { esito, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: 403 })
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
        expect(righeErrore.join(' ')).toMatch(/riattivazione rifiutata.*Resource not accessible/)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('stessa notte, stesso rifiuto: stessa chiave e STESSO testo anche se il cron parte in ritardo (testo diverso = 409)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            const f = fetchFinto({ [DISPATCH_BACKUP]: [CREDENZIALI], [WF_BACKUP]: [CREDENZIALI], [RESEND]: [ACCETTATA] })
            vi.setSystemTime(new Date('2026-10-21T02:23:04Z'))
            await unGiroBackup(f)
            vi.setSystemTime(new Date('2026-10-21T02:41:57Z'))
            await unGiroBackup(f)

            const [prima, seconda] = f.a(RESEND)
            expect(seconda.idem).toBe(prima.idem)
            expect(seconda.corpo).toBe(prima.corpo)
        } finally {
            vi.useRealTimers()
        }
    })

    it('workflow spento A MANO: NON lo riaccende, non manda email, lo scrive', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [SPENTO],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_manually"}' }],
        })

        const { esito, righe } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('spento-a-mano')
        expect(f.a(ABILITA_BACKUP)).toHaveLength(0)
        expect(f.a(RESEND)).toHaveLength(0)
        expect(righe.join(' ')).toContain('esito=spento-a-mano')
    })

    it('GitHub rifiuta (401): console.error col corpo, email con la chiave della notte e il mittente del campanello', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [CREDENZIALI], [WF_BACKUP]: [CREDENZIALI], [RESEND]: [ACCETTATA] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(righeErrore.join(' ')).toMatch(/monitor-backup: esito=fallito.*401.*Bad credentials/)
        expect(righeErrore.join(' ')).not.toContain(TOKEN)
        const [email] = f.a(RESEND)
        expect(email.idem).toBe('kidville-backup-non-partito-2026-10-21')
        expect(email.auth).toBe('Bearer re_prova')
        const corpo = JSON.parse(email.corpo!)
        expect(MITTENTE_CAMPANELLO).toBeTruthy()
        expect(corpo.from).toBe(MITTENTE_CAMPANELLO)
        expect(corpo.subject).toBe('Backup notturno NON partito')
        expect(corpo.to).toEqual(['a@esempio.test', 'b@esempio.test'])
        expect(corpo.html).toContain('Bad credentials')
        expect(corpo.html).toContain(LINK_GIRI_BACKUP)
        expect(corpo.html).not.toContain(TOKEN)
        expect(righe.join(' ')).toContain('monitor-email: esito=accettata chiave=kidville-backup-non-partito-2026-10-21')
    })

    it('422 «unexpected inputs» (workflow su main senza `origine`): NON riprova senza input, e avvisa', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [{ status: 422, testo: '{"message":"Unexpected inputs provided: [\\"origine\\"]"}' }],
            [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"active"}' }],
            [RESEND]: [ACCETTATA],
        })

        const { esito } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('senza token non chiama GitHub, lo dice e manda l\'email', async () => {
        const f = fetchFinto({ [RESEND]: [ACCETTATA] })

        const { esito, righeErrore } = await unGiroBackup(f, '')

        expect(f.a(DISPATCH_BACKUP)).toHaveLength(0)
        expect(esito.lancio.http).toBe(0)
        expect(righeErrore.join(' ')).toContain('manca GITHUB_TOKEN_CAMPANELLO')
        expect(f.a(RESEND)).toHaveLength(1)
    })

    it('senza i segreti di Resend lo scrive in console.error e va avanti', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [{ status: 500, testo: 'boom' }], [WF_BACKUP]: [{ status: 500, testo: 'boom' }] })

        const { esito, righeErrore } = await unGiroBackup(f, TOKEN, {})

        expect(esito.email?.ok).toBe(false)
        expect(righeErrore.join(' ')).toContain('mancano RESEND_API_KEY o SENTINELLA_DESTINATARI')
        expect(f.a(RESEND)).toHaveLength(0)
    })

    it('Resend rifiuta: il corpo del rifiuto finisce nel log (un 403 senza corpo non dice perché)', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [CREDENZIALI],
            [WF_BACKUP]: [CREDENZIALI],
            [RESEND]: [{ status: 403, testo: '{"message":"The domain is not verified"}' }],
        })

        const { righeErrore } = await unGiroBackup(f)

        expect(righeErrore.join(' ')).toMatch(/monitor-email: esito=non-spedita.*403.*domain is not verified/)
    })

    it('un rifiuto che riportasse il token (un proxy che rimanda le intestazioni): né il log né l\'email lo contengono', async () => {
        const eco = { status: 502, testo: `<html>Authorization: Bearer ${TOKEN} · token=${TOKEN}</html>` }
        const f = fetchFinto({ [DISPATCH_BACKUP]: [eco], [WF_BACKUP]: [eco], [RESEND]: [ACCETTATA] })

        const { esito, righe, righeErrore } = await unGiroBackup(f)

        expect(esito.lancio.esito).toBe('fallito')
        expect(righeErrore.join(' ')).toMatch(/monitor-backup: esito=fallito.*HTTP 502.*\[nascosto\]/)
        const [email] = f.a(RESEND)
        for (const testo of [email.corpo!, esito.lancio.corpo, ...righe, ...righeErrore]) {
            expect(testo).not.toContain(TOKEN)
        }
    })

    it('un rifiuto di Resend che riportasse la sua chiave: il log non la contiene', async () => {
        const f = fetchFinto({
            [DISPATCH_BACKUP]: [CREDENZIALI],
            [WF_BACKUP]: [CREDENZIALI],
            [RESEND]: [{ status: 401, testo: '{"message":"API key re_prova is invalid"}' }],
        })

        const { righe, righeErrore } = await unGiroBackup(f)

        expect(righeErrore.join(' ')).toMatch(/monitor-email: esito=non-spedita.*401.*\[nascosto\] is invalid/)
        expect([...righe, ...righeErrore].join(' ')).not.toContain('re_prova')
    })

    it('la rete cade: esito fallito, col motivo', async () => {
        const f = fetchFinto({ [DISPATCH_BACKUP]: [new Error('timeout')], [RESEND]: [ACCETTATA] })

        const { esito } = await unGiroBackup(f)

        expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: null })
        expect(esito.lancio.corpo).toContain('timeout')
    })
})

describe('chiaveIdempotenza', () => {
    it('una per notte per il backup, una per ora per il sito giù; solo caratteri che Resend accetta', () => {
        expect(chiaveIdempotenza('backup', new Date('2026-10-21T02:23:00Z'))).toBe('kidville-backup-non-partito-2026-10-21')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:05:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:55:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
        expect(chiaveIdempotenza('vivo', new Date('2026-10-19T11:00:00Z'))).toBe('kidville-vivo-giu-2026-10-19T11')
        for (const k of [chiaveIdempotenza('backup', NOTTE), chiaveIdempotenza('vivo', NOTTE)]) {
            expect(k).toMatch(/^[A-Za-z0-9:_.-]{1,256}$/)
        }
    })
})
