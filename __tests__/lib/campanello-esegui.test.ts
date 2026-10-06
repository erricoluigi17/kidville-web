import { describe, it, expect, vi } from 'vitest'
import { esegui } from '../../scripts/campanello/campanello.mjs'
import { esegui as eseguiDopoDeploy, aspettaVersione } from '../../scripts/campanello/dopo-deploy.mjs'
import { creaGitHub, escapeHtml, mandaEmail } from '../../scripts/campanello/allarme.mjs'

/**
 * IL GIRO DEL CAMPANELLO E LA VERIFICA DOPO IL DEPLOY, con un GitHub e un Resend finti.
 *
 * La decisione («è un incidente?») ha i suoi test in `campanello-valuta.test.ts`. Qui si prova il
 * COMPORTAMENTO: cosa viene aperto, ricordato e chiuso, cosa NON viene chiuso, e che un'email che non
 * parte faccia fallire il giro invece di sparire.
 */

const ORA = 3_600_000
const ADESSO = Date.parse('2026-10-07T08:00:00Z')
const BASE = 'https://app.kidville.it'
const SEGRETI = { chiaveResend: 're_prova', destinatari: 'a@esempio.test,b@esempio.test' }

interface Segnalazione {
    numero: number
    titolo: string
    corpo: string
    aperta: boolean
    commenti: string[]
    ultimoAggiornamento: string
}

/** Un GitHub in memoria con la stessa interfaccia di `creaGitHub`. */
function ghFinto(opzioni: { giri?: unknown[] | Error; aperte?: Segnalazione[]; confronto?: string } = {}) {
    const segnalazioni: Segnalazione[] = opzioni.aperte ?? []
    let prossimo = 100
    return {
        segnalazioni,
        async elencaAperte() {
            return segnalazioni
                .filter((s) => s.aperta)
                .map((s) => ({ numero: s.numero, titolo: s.titolo, ultimoAggiornamento: s.ultimoAggiornamento }))
        },
        async apri(incidente: { chiave: string; titolo: string }, corpo: string) {
            const numero = prossimo++
            segnalazioni.push({
                numero,
                titolo: `[${incidente.chiave}] ${incidente.titolo}`,
                corpo,
                aperta: true,
                commenti: [],
                ultimoAggiornamento: new Date(ADESSO).toISOString(),
            })
            return numero
        },
        async commenta(numero: number, testo: string) {
            segnalazioni.find((s) => s.numero === numero)!.commenti.push(testo)
        },
        async chiudi(numero: number, testo: string) {
            const s = segnalazioni.find((x) => x.numero === numero)!
            s.commenti.push(testo)
            s.aperta = false
        },
        async giriBackupRiusciti() {
            if (opzioni.giri instanceof Error) throw opzioni.giri
            return opzioni.giri ?? [{ conclusion: 'success', updated_at: new Date(ADESSO - 5 * ORA).toISOString() }]
        },
        async confronta() {
            return opzioni.confronto ?? 'sconosciuto'
        },
    }
}

function segnalazioneAperta(numero: number, chiave: string, oreFa = 1): Segnalazione {
    return {
        numero,
        titolo: `[${chiave}] titolo`,
        corpo: '',
        aperta: true,
        commenti: [],
        ultimoAggiornamento: new Date(ADESSO - oreFa * ORA).toISOString(),
    }
}

type Risposta = { status: number; corpo?: unknown; testo?: string; intestazioni?: Record<string, string> }

/** Un `fetch` finto: per URL, una sequenza di risposte (l'ultima si ripete). Resend risponde 200. */
function fetchFinto(per: Record<string, Risposta[]>, resend: Risposta = { status: 200, testo: '{"id":"e1"}' }) {
    const chiamate: { url: string; corpo?: string }[] = []
    const indice: Record<string, number> = {}
    const impl = vi.fn(async (url: string, init?: { body?: string }) => {
        chiamate.push({ url, corpo: init?.body })
        let r: Risposta
        if (url.startsWith('https://api.resend.com')) r = resend
        else {
            const seq = per[url]
            if (!seq) throw new Error(`fetch finto: URL non previsto ${url}`)
            const i = Math.min(indice[url] ?? 0, seq.length - 1)
            indice[url] = (indice[url] ?? 0) + 1
            r = seq[i]
        }
        return {
            status: r.status,
            ok: r.status >= 200 && r.status < 300,
            text: async () => r.testo ?? JSON.stringify(r.corpo ?? {}),
            headers: new Headers(r.intestazioni ?? {}),
        }
    })
    return { impl: impl as unknown as typeof fetch, chiamate, richiesteA: (u: string) => chiamate.filter((c) => c.url === u).length }
}

const VIVO_OK = { status: 200, corpo: { stato: 'ok', controlli: [], regione: 'dub1', versione: 'abcdef012345' } }
const VIVO_GIU = {
    status: 503,
    corpo: { stato: 'down', controlli: [{ nome: 'auth', esito: 'giu', dettaglio: 'auth 500 x' }] },
}
const SALUTE_OK = { status: 200, corpo: { stato: 'ok', controlli: [{ nome: 'config', esito: 'ok' }] } }
const SALUTE_CONFIG = {
    status: 200,
    corpo: { stato: 'degraded', controlli: [{ nome: 'config', esito: 'degradato', dettaglio: 'variabili assenti: CRON_SECRET' }] },
}

async function giro(
    gh: ReturnType<typeof ghFinto>,
    f: ReturnType<typeof fetchFinto>,
    extra: Record<string, unknown> = {},
) {
    const dormi = vi.fn(async () => {})
    const log = vi.fn()
    const esito = await esegui({
        urlBase: BASE,
        gh,
        segreti: SEGRETI,
        linkGiro: 'https://github.com/o/r/actions/runs/1',
        adesso: () => ADESSO,
        dormi,
        fetchImpl: f.impl,
        log,
        ...extra,
    })
    return { esito, dormi, log }
}

describe('il giro del campanello', () => {
    it('con tutto sano non apre, non ricorda e non chiude niente, e non spedisce email', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

        const { esito } = await giro(gh, f)

        expect(esito.incidenti).toEqual([])
        expect(esito.esiti).toEqual({ aperte: 0, ricordate: 0, chiuse: 0 })
        expect(gh.segnalazioni).toEqual([])
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(0)
    })

    it('con il vivo giù per tre tentativi apre UNA segnalazione e manda UNA email, con i due controlli nel testo', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

        const { esito, dormi } = await giro(gh, f)

        expect(f.richiesteA(`${BASE}/api/health/vivo`)).toBe(3)
        expect(dormi).toHaveBeenCalledTimes(2)
        expect(dormi).toHaveBeenCalledWith(15_000)
        expect(gh.segnalazioni).toHaveLength(1)
        expect(gh.segnalazioni[0].titolo.startsWith('[app-giu]')).toBe(true)
        expect(gh.segnalazioni[0].corpo).toContain('auth(giu)')
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(1)
        expect(esito.errori).toEqual([])
        // Il sito è giù: la salute non si legge (il dettaglio sta già nell'incidente del vivo).
        expect(f.richiesteA(`${BASE}/api/health`)).toBe(0)
    })

    it('uno scatto isolato (503 poi 200) NON sveglia nessuno', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU, VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

        const { esito } = await giro(gh, f)

        expect(esito.incidenti).toEqual([])
        expect(gh.segnalazioni).toEqual([])
    })

    it('un incidente già segnalato NON rimanda l\'email a ogni giro', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(7, 'app-giu')] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

        const { esito } = await giro(gh, f)

        expect(esito.esiti.aperte).toBe(0)
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(0)
        expect(gh.segnalazioni).toHaveLength(1)
    })

    it('una salute degraded che dura (due letture a 45 s) apre la segnalazione del controllo', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_CONFIG] })

        const { dormi } = await giro(gh, f)

        expect(dormi).toHaveBeenCalledWith(45_000)
        expect(gh.segnalazioni.map((s) => s.titolo.split(']')[0])).toEqual(['[salute:config'])
        expect(gh.segnalazioni[0].corpo).toContain('CRON_SECRET')
    })

    it('una salute degraded che sparisce alla seconda lettura NON apre niente (rumore di un minuto)', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_CONFIG, SALUTE_OK] })

        const { esito } = await giro(gh, f)

        expect(esito.incidenti).toEqual([])
        expect(gh.segnalazioni).toEqual([])
    })

    it('quando il controllo rientra chiude la sua segnalazione, con un commento', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(8, 'salute:config')] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

        const { esito } = await giro(gh, f)

        expect(esito.esiti.chiuse).toBe(1)
        expect(gh.segnalazioni[0].aperta).toBe(false)
        expect(gh.segnalazioni[0].commenti[0]).toContain('Rientrato')
    })

    it('con il sito GIÙ non chiude le segnalazioni della salute: «non l\'ho guardata» non è «è rientrata»', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(8, 'salute:config'), segnalazioneAperta(9, 'backup-vecchio')] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

        await giro(gh, f)

        expect(gh.segnalazioni.find((s) => s.numero === 8)!.aperta).toBe(true)
        // Il backup invece è stato misurato (5 ore fa: sano) e la sua segnalazione si chiude.
        expect(gh.segnalazioni.find((s) => s.numero === 9)!.aperta).toBe(false)
    })

    it('senza nessun giro automatico riuscito del backup apre `backup-vecchio`', async () => {
        const gh = ghFinto({ giri: [] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

        await giro(gh, f)

        expect(gh.segnalazioni.map((s) => s.titolo.split(']')[0])).toEqual(['[backup-vecchio'])
    })

    it('se l\'API dei giri non risponde NON apre un incidente e NON chiude quello aperto', async () => {
        const gh = ghFinto({ giri: new Error('GitHub GET … → 403: rate limit'), aperte: [segnalazioneAperta(9, 'backup-vecchio')] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

        const { esito, log } = await giro(gh, f)

        expect(esito.incidenti).toEqual([])
        expect(gh.segnalazioni[0].aperta).toBe(true)
        expect(log.mock.calls.some((c) => String(c[0]).includes('non verificabile'))).toBe(true)
    })

    it('un incidente aperto da più di 24 ore riceve un promemoria, senza email', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(7, 'app-giu', 30)] })
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

        const { esito } = await giro(gh, f)

        expect(esito.esiti.ricordate).toBe(1)
        expect(gh.segnalazioni[0].commenti[0]).toContain('Promemoria')
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(0)
    })

    describe('quando l\'email non può partire il giro FALLISCE (la segnalazione c\'è comunque)', () => {
        it('Resend rifiuta con 403: il corpo del provider resta nell\'errore, mai buttato', async () => {
            const gh = ghFinto()
            const f = fetchFinto(
                { [`${BASE}/api/health/vivo`]: [VIVO_GIU] },
                { status: 403, testo: '{"message":"the kidville.it domain is not verified"}' },
            )

            const { esito } = await giro(gh, f)

            expect(gh.segnalazioni).toHaveLength(1)
            expect(esito.errori).toHaveLength(1)
            expect(esito.errori[0]).toContain('403')
            expect(esito.errori[0]).toContain('domain is not verified')
        })

        it('mancano i segreti: errore esplicito, non una nota a piè di pagina', async () => {
            const gh = ghFinto()
            const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

            const { esito } = await giro(gh, f, { segreti: { chiaveResend: '', destinatari: '' } })

            expect(gh.segnalazioni).toHaveLength(1)
            expect(esito.errori[0]).toContain('mancano RESEND_API_KEY')
        })
    })

    describe('la prova dell\'allarme (simula_guasto)', () => {
        it('apre una segnalazione `prova` e manda l\'email marcata PROVA, senza leggere il sito', async () => {
            const gh = ghFinto()
            const f = fetchFinto({})

            const { esito } = await giro(gh, f, { simulaGuasto: true })

            expect(esito.errori).toEqual([])
            expect(gh.segnalazioni[0].titolo.startsWith('[prova]')).toBe(true)
            expect(gh.segnalazioni[0].corpo).toContain('SIMULATO')
            const email = f.chiamate.find((c) => c.url === 'https://api.resend.com/emails')!
            expect(JSON.parse(email.corpo!).subject).toContain('PROVA')
            expect(f.richiesteA(`${BASE}/api/health/vivo`)).toBe(0)
        })

        it('NON chiude gli incidenti veri (non li ha misurati)', async () => {
            const gh = ghFinto({ aperte: [segnalazioneAperta(7, 'app-giu'), segnalazioneAperta(8, 'salute:config')] })
            const f = fetchFinto({})

            await giro(gh, f, { simulaGuasto: true })

            expect(gh.segnalazioni.filter((s) => s.aperta && !s.titolo.startsWith('[prova]'))).toHaveLength(2)
        })

        it('il giro normale successivo chiude la prova da solo', async () => {
            const gh = ghFinto({ aperte: [segnalazioneAperta(5, 'prova')] })
            const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_OK], [`${BASE}/api/health`]: [SALUTE_OK] })

            const { esito } = await giro(gh, f)

            expect(esito.esiti.chiuse).toBe(1)
            expect(gh.segnalazioni[0].aperta).toBe(false)
        })
    })
})

describe('creaGitHub (le chiamate vere all\'API)', () => {
    it('apre la segnalazione con l\'etichetta `campanello` e crea l\'etichetta se manca (422 = esiste già)', async () => {
        const f = fetchFinto({
            'https://api.github.com/repos/o/r/labels': [{ status: 422, corpo: { message: 'already_exists' } }],
            'https://api.github.com/repos/o/r/issues': [{ status: 201, corpo: { number: 42 } }],
        })
        const gh = creaGitHub({ repo: 'o/r', token: 't', fetchImpl: f.impl })

        const numero = await gh.apri({ chiave: 'app-giu', titolo: 'Il sito non risponde' }, 'corpo')

        expect(numero).toBe(42)
        const creata = JSON.parse(f.chiamate.find((c) => c.url.endsWith('/issues'))!.corpo!)
        expect(creata).toMatchObject({ title: '[app-giu] Il sito non risponde', labels: ['campanello'] })
    })

    it('un errore di GitHub porta il corpo della risposta (mai solo lo status)', async () => {
        const f = fetchFinto({
            'https://api.github.com/repos/o/r/issues?state=open&labels=campanello&per_page=100': [
                { status: 403, testo: '{"message":"Resource not accessible by integration"}' },
            ],
        })
        const gh = creaGitHub({ repo: 'o/r', token: 't', fetchImpl: f.impl })

        await expect(gh.elencaAperte()).rejects.toThrow(/403.*Resource not accessible by integration/)
    })

    it('le pull request non sono segnalazioni del campanello', async () => {
        const f = fetchFinto({
            'https://api.github.com/repos/o/r/issues?state=open&labels=campanello&per_page=100': [
                {
                    status: 200,
                    corpo: [
                        { number: 1, title: '[app-giu] x', updated_at: 'd' },
                        { number: 2, title: '[app-giu] y', updated_at: 'd', pull_request: {} },
                    ],
                },
            ],
        })
        const gh = creaGitHub({ repo: 'o/r', token: 't', fetchImpl: f.impl })

        expect((await gh.elencaAperte()).map((s: { numero: number }) => s.numero)).toEqual([1])
    })

    it('legge SOLO i giri automatici e riusciti del backup', async () => {
        const f = fetchFinto({
            'https://api.github.com/repos/o/r/actions/workflows/backup-notturno.yml/runs?event=schedule&status=success&per_page=5': [
                { status: 200, corpo: { workflow_runs: [{ conclusion: 'success', updated_at: 'x' }] } },
            ],
        })
        const gh = creaGitHub({ repo: 'o/r', token: 't', fetchImpl: f.impl })

        expect(await gh.giriBackupRiusciti()).toHaveLength(1)
    })
})

describe('mandaEmail', () => {
    it('l\'HTML dell\'email esce con l\'escape: un testo con tag non diventa markup', async () => {
        const f = fetchFinto({})

        await mandaEmail({
            chiaveResend: 'k',
            destinatari: 'a@esempio.test',
            oggetto: 'Kidville: <script>x</script>',
            introHtml: escapeHtml('<img src=x onerror=1>'),
            link: 'https://github.com/o/r/actions/runs/1',
            quando: 'adesso',
            fetchImpl: f.impl,
        })

        const html = JSON.parse(f.chiamate[0].corpo!).html as string
        expect(html).not.toContain('<script>')
        expect(html).not.toContain('<img')
        expect(html).toContain('&lt;script&gt;')
    })

    it('l\'indirizzo dei destinatari non finisce mai nella segnalazione pubblica', async () => {
        const gh = ghFinto()
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [VIVO_GIU] })

        await giro(gh, f)

        expect(JSON.stringify(gh.segnalazioni)).not.toContain('esempio.test')
        expect(JSON.stringify(gh.segnalazioni)).not.toContain('re_prova')
    })
})

describe('la verifica dopo il deploy', () => {
    const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
    const vivoCon = (versione: string | undefined, regione = 'dub1', vercelId = 'fra1::dub1::x-1') => ({
        status: 200,
        corpo: { stato: 'ok', controlli: [], regione, ...(versione ? { versione } : {}) },
        intestazioni: { 'x-vercel-id': vercelId },
    })

    async function verifica(opz: {
        per: Record<string, Risposta[]>
        gh?: ReturnType<typeof ghFinto>
        resend?: Risposta
    }) {
        const gh = opz.gh ?? ghFinto()
        const f = fetchFinto(opz.per, opz.resend)
        const dormi = vi.fn(async () => {})
        const log = vi.fn()
        const esito = await eseguiDopoDeploy({
            urlBase: BASE,
            shaAtteso: SHA,
            gh,
            segreti: SEGRETI,
            linkGiro: 'https://github.com/o/r/actions/runs/2',
            adesso: () => ADESSO,
            dormi,
            fetchImpl: f.impl,
            log,
        })
        return { esito, gh, f, dormi }
    }

    it('il sito serve il rilascio nuovo, in dub1, vivo: verificato, nessuna segnalazione', async () => {
        const { esito, gh } = await verifica({
            per: { [`${BASE}/api/health/vivo`]: [vivoCon('abcdef012345')], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('ok')
        expect(gh.segnalazioni).toEqual([])
    })

    it('aspetta che il dominio serva il rilascio nuovo (alias in ritardo): al terzo tentativo è allineato', async () => {
        const { esito, dormi } = await verifica({
            per: {
                [`${BASE}/api/health/vivo`]: [vivoCon('111111111111'), vivoCon('111111111111'), vivoCon('abcdef012345')],
                [`${BASE}/api/health`]: [SALUTE_OK],
            },
        })

        expect(esito.esito).toBe('ok')
        expect(dormi).toHaveBeenCalledTimes(2)
    })

    it('la regione sbagliata (iad1) FERMA il rilascio: apre la segnalazione, spedisce l\'email, esito guasto', async () => {
        const { esito, gh, f } = await verifica({
            per: {
                [`${BASE}/api/health/vivo`]: [vivoCon('abcdef012345', 'iad1', 'fra1::iad1::x-1')],
                [`${BASE}/api/health`]: [SALUTE_OK],
            },
        })

        expect(esito.esito).toBe('guasto')
        expect(gh.segnalazioni).toHaveLength(1)
        expect(gh.segnalazioni[0].titolo).toContain('[deploy:abcdef0]')
        expect(gh.segnalazioni[0].corpo).toContain('iad1')
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(1)
    })

    it('un rilascio buono chiude la segnalazione del rilascio rotto precedente', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(70, 'deploy:1234567')] })
        const { esito } = await verifica({
            gh,
            per: { [`${BASE}/api/health/vivo`]: [vivoCon('abcdef012345')], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('ok')
        expect(gh.segnalazioni[0].aperta).toBe(false)
    })

    it('un secondo giro sullo stesso rilascio rotto NON riapre né rimanda l\'email', async () => {
        const gh = ghFinto({ aperte: [segnalazioneAperta(71, 'deploy:abcdef0')] })
        const { esito, f } = await verifica({
            gh,
            per: { [`${BASE}/api/health/vivo`]: [vivoCon('abcdef012345', 'iad1', 'fra1::iad1::x')], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('guasto')
        expect(gh.segnalazioni).toHaveLength(1)
        expect(f.richiesteA('https://api.resend.com/emails')).toBe(0)
    })

    it('se in produzione è già andato un rilascio PIÙ NUOVO il giro si ferma senza allarmare', async () => {
        const gh = ghFinto({ confronto: 'ahead' })
        const { esito } = await verifica({
            gh,
            per: { [`${BASE}/api/health/vivo`]: [vivoCon('999999999999')], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('superato')
        expect(gh.segnalazioni).toEqual([])
    })

    it('se dopo 10 minuti serve ancora un rilascio vecchio (non successore) è un guasto', async () => {
        const { esito, gh } = await verifica({
            gh: ghFinto({ confronto: 'behind' }),
            per: { [`${BASE}/api/health/vivo`]: [vivoCon('111111111111')], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('guasto')
        expect(esito.guasti[0]).toContain('serve ancora 111111111111')
        expect(gh.segnalazioni).toHaveLength(1)
    })

    it('se l\'app non dichiara la versione verifica lo stesso, e lo dice', async () => {
        const { esito } = await verifica({
            per: { [`${BASE}/api/health/vivo`]: [vivoCon(undefined)], [`${BASE}/api/health`]: [SALUTE_OK] },
        })

        expect(esito.esito).toBe('ok')
        expect(esito.note.join(' ')).toContain('non dichiara la versione')
    })

    it('aspettaVersione: 30 tentativi a 20 secondi (10 minuti) e poi si arrende', async () => {
        const f = fetchFinto({ [`${BASE}/api/health/vivo`]: [vivoCon('111111111111')] })
        const dormi = vi.fn(async () => {})

        const r = await aspettaVersione({
            urlBase: BASE,
            shaAtteso: SHA,
            gh: ghFinto({ confronto: 'diverged' }),
            dormi,
            fetchImpl: f.impl,
            log: () => {},
        })

        expect(r.stato).toBe('diverso')
        expect(f.richiesteA(`${BASE}/api/health/vivo`)).toBe(30)
        expect(dormi).toHaveBeenCalledTimes(29)
        expect(dormi).toHaveBeenCalledWith(20_000)
    })
})
