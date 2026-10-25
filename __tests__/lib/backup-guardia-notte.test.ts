import { describe, it, expect, vi } from 'vitest'
import {
    ORE_GUARDIA,
    TITOLO_COMPLETO,
    WORKFLOW,
    decidi,
    eCompletoRiuscito,
    esegui,
} from '../../scripts/backup/guardia-notte.mjs'

/**
 * LA GUARDIA DELLE 20 ORE del backup notturno (`scripts/backup/guardia-notte.mjs`), con numeri
 * letterali e un GitHub finto. Ogni caso è una notte vera: il Worker ha fatto il backup alle 02:23
 * e lo `schedule` di GitHub, arrivato alle 07:30, deve annullarsi; il Worker ha fallito, e lo
 * `schedule` deve partire. Un guasto della guardia stessa deve far PARTIRE il backup, mai fermarlo.
 */

const ADESSO = Date.parse('2026-10-21T07:30:00Z')
const ID_CORRENTE = 9000
const DA_FUORI = 'Backup notturno completo (da Cloudflare)'
/** Il lancio delle 02:23 dal Worker, finito alle 02:41. */
const dalWorker = (extra: Record<string, unknown> = {}) => ({
    id: 101,
    event: 'workflow_dispatch',
    display_title: DA_FUORI,
    conclusion: 'success',
    updated_at: '2026-10-21T02:41:00Z',
    ...extra,
})
const URL_GIRI = 'https://api.github.com/repos/o/r/actions/workflows/backup-notturno.yml/runs?status=success&per_page=30'

function githubFinto(risposta: { status: number; testo: string } | Error) {
    const chiamate: { url: string; auth?: string }[] = []
    const impl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        chiamate.push({ url, auth: init?.headers?.Authorization })
        if (risposta instanceof Error) throw risposta
        return { status: risposta.status, text: async () => risposta.testo }
    })
    return { impl: impl as unknown as typeof fetch, chiamate }
}

describe('eCompletoRiuscito', () => {
    it('vale il lancio del Worker, lo schedule (anche di prima del run-name) e un completo a mano', () => {
        expect(eCompletoRiuscito(dalWorker(), ID_CORRENTE)).toBe(true)
        expect(eCompletoRiuscito(dalWorker({ event: 'schedule', display_title: 'Backup notturno (database e file → R2)' }), ID_CORRENTE)).toBe(true)
        expect(eCompletoRiuscito(dalWorker({ display_title: TITOLO_COMPLETO }), ID_CORRENTE)).toBe(true)
    })

    it('non vale un giro di prova, fallito o annullato, né il giro corrente', () => {
        expect(eCompletoRiuscito(dalWorker({ display_title: 'Backup notturno prova' }), ID_CORRENTE)).toBe(false)
        expect(eCompletoRiuscito(dalWorker({ conclusion: 'failure' }), ID_CORRENTE)).toBe(false)
        expect(eCompletoRiuscito(dalWorker({ conclusion: 'cancelled' }), ID_CORRENTE)).toBe(false)
        expect(eCompletoRiuscito(dalWorker({ id: ID_CORRENTE }), String(ID_CORRENTE))).toBe(false)
        expect(eCompletoRiuscito(null, ID_CORRENTE)).toBe(false)
    })
})

describe('decidi', () => {
    it('il Worker ha fatto il backup (finito alle 02:41): lo schedule delle 07:30 si annulla', () => {
        const d = decidi({ giri: [dalWorker()], adesso: ADESSO, idCorrente: ID_CORRENTE })

        expect(d.salta).toBe(true)
        expect(d.perche).toContain('4.8 ore')
    })

    // NUMERI LETTERALI: 20 ore esatte contano ancora, 20 ore e un minuto no.
    it('esattamente 20 ore fa conta ancora; 20 ore e 1 minuto no', () => {
        expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-20T11:30:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(true)
        expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-20T11:29:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
    })

    it('il Worker ha fallito stanotte e l\'ultimo completo è di ieri alle 02:41: lo schedule PARTE', () => {
        const giri = [dalWorker({ conclusion: 'failure' }), dalWorker({ id: 100, updated_at: '2026-10-20T02:41:00Z' })]

        expect(decidi({ giri, adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
    })

    it('una data illeggibile o nel futuro non conta come «già fatto»', () => {
        expect(decidi({ giri: [dalWorker({ updated_at: 'boh' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
        expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-21T09:00:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
    })

    it('nessun giro: il backup parte', () => {
        expect(decidi({ giri: [], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
    })

    it('la finestra sta sopra il ritardo peggiore dello schedule (7 h 12 min) e sotto le 24 ore', () => {
        // 02:23 → 09:35 è il ritardo peggiore misurato (rapporto del 20/10). Sotto, uno schedule in
        // ritardo farebbe un secondo backup; a 24 ore o più, la notte dopo verrebbe saltata.
        expect(ORE_GUARDIA).toBeGreaterThanOrEqual(8)
        expect(ORE_GUARDIA).toBeLessThanOrEqual(23)
    })
})

describe('esegui (fail-open: un guasto della guardia fa PARTIRE il backup)', () => {
    async function unaGuardia(risposta: { status: number; testo: string } | Error, token = 't') {
        const g = githubFinto(risposta)
        const log = vi.fn()
        const d = await esegui({ repo: 'o/r', token, idCorrente: ID_CORRENTE, adesso: ADESSO, fetchImpl: g.impl, log })
        return { d, g, righe: log.mock.calls.map((c) => String(c[0])).join(' ') }
    }

    it('legge i giri riusciti del backup col token del giro, e decide', async () => {
        const { d, g, righe } = await unaGuardia({ status: 200, testo: JSON.stringify({ workflow_runs: [dalWorker()] }) })

        expect(WORKFLOW).toBe('backup-notturno.yml')
        expect(g.chiamate.map((c) => c.url)).toEqual([URL_GIRI])
        expect(g.chiamate[0].auth).toBe('Bearer t')
        expect(d.salta).toBe(true)
        expect(righe).toContain('guardia: esito=salta giri_letti=1')
    })

    it('GitHub risponde 403: il backup parte, e il corpo del rifiuto è nel log', async () => {
        const { d, righe } = await unaGuardia({ status: 403, testo: '{"message":"Resource not accessible by integration"}' })

        expect(d.salta).toBe(false)
        expect(righe).toMatch(/esito=non-verificabile.*403.*Resource not accessible/)
    })

    it('senza token non chiama GitHub e il backup parte', async () => {
        const { d, g } = await unaGuardia({ status: 200, testo: '{}' }, '')

        expect(g.chiamate).toHaveLength(0)
        expect(d.salta).toBe(false)
    })

    it('una risposta senza workflow_runs, o non JSON: il backup parte', async () => {
        expect((await unaGuardia({ status: 200, testo: '{}' })).d.salta).toBe(false)
        expect((await unaGuardia({ status: 200, testo: '<html>' })).d.salta).toBe(false)
    })

    it('la rete cade: il backup parte', async () => {
        const { d, righe } = await unaGuardia(new Error('timeout'))

        expect(d.salta).toBe(false)
        expect(righe).toContain('timeout')
    })
})
