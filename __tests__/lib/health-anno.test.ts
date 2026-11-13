// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type RispostaRpc, type Riga } from '../fixtures/finto-supabase'
import {
    controlloAnno,
    controlloAnnoInvarianti,
    eseguiQualita,
    eseguiSalute,
    JOB_CRON,
    JOB_CRON_NON_SORVEGLIATI,
} from '@/lib/health/controlli'
import { logEvento } from '@/lib/logging/logger'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * COMPITO 4.5.2 · LA SALUTE DELL'ANNO SCOLASTICO (`salute_anno`), UN CASO PER VOLTA, CON IL FINTO CLIENT.
 *
 * Due controlli: `anno` (in `/api/health`: manca l'anno successivo oltre il suo giorno) e `anno-invarianti` (in
 * `/api/health/qualita`, che non accende nessun allarme: una invariante non a zero è un dato storto, non un servizio rotto).
 * Mai `giu`. Numeri letterali, un orologio fisso.
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-11-09T10:00:00.000Z')

function fa(ms: number): string {
    return new Date(ADESSO - ms).toISOString()
}

type Salute = { sedi_senza_successivo: number; in_ritardo_giorni: number; invarianti_non_zero: number }

function client(rpc: Record<string, (args: Riga) => RispostaRpc | Promise<RispostaRpc>>): SupabaseClient {
    return creaFintoSupabase({}, [], { errori: {}, rpc }) as unknown as SupabaseClient
}
const conSalute = (s: Salute) => client({ salute_anno: () => ({ data: s, error: null }) })

beforeEach(() => {
    vi.clearAllMocks()
})
afterEach(() => {
    vi.unstubAllEnvs()
})

describe('anno · l’anno successivo è stato creato in tempo?', () => {
    it('tutto in regola: ok', async () => {
        const c = conSalute({ sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 0 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ nome: 'anno', esito: 'ok' })
    })

    it('una sede senza successivo da due giorni: degradato, col solo numero', async () => {
        const c = conSalute({ sedi_senza_successivo: 1, in_ritardo_giorni: 2, invarianti_non_zero: 0 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({
            nome: 'anno',
            esito: 'degradato',
            dettaglio: '1 sede senza l’anno successivo, in ritardo fino a 2 giorni',
        })
    })

    it('una sede nel giorno stesso del successivo (meno di un giorno): ok, il tick gira ogni ora', async () => {
        const c = conSalute({ sedi_senza_successivo: 1, in_ritardo_giorni: 0, invarianti_non_zero: 0 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ nome: 'anno', esito: 'ok' })
    })

    it('un solo giorno di ritardo è già degradato (il confine è `>= 1`)', async () => {
        const c = conSalute({ sedi_senza_successivo: 3, in_ritardo_giorni: 1, invarianti_non_zero: 0 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: '3 sedi senza l’anno successivo, in ritardo fino a 1 giorno' })
    })

    it('le invarianti non fanno suonare `anno`', async () => {
        const c = conSalute({ sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 4 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'ok' })
    })

    it('funzione assente → non degradato e log `info`', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(10 * MIN))
        const c = client({ salute_anno: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) })

        expect(await controlloAnno(c, ADESSO)).toMatchObject({
            nome: 'anno',
            esito: 'ok',
            dettaglio: 'salute_anno non ancora installata (PGRST202)',
        })
        expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
            'rpc',
            'info',
            expect.objectContaining({ operazione: 'health:salute_anno', esito: 'rpc-non-ancora-installata' }),
        )
    })

    it('42883 (undefined function) è la stessa assenza', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(5 * MIN))
        const c = client({ salute_anno: () => ({ data: null, error: { code: '42883', message: 'x' } }) })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'ok', dettaglio: 'salute_anno non ancora installata (42883)' })
    })

    it('assente da oltre 30 minuti dalla build: degradato (l’integrazione non l’ha applicata)', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(45 * MIN))
        const c = client({ salute_anno: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'degradato' })
    })

    it('un altro errore (PGRST203, due funzioni omonime) non è un’assenza: degradato subito, col solo codice', async () => {
        const c = client({ salute_anno: () => ({ data: null, error: { code: 'PGRST203', message: 'testo che non deve uscire' } }) })
        const r = await controlloAnno(c, ADESSO)
        expect(r.esito).toBe('degradato')
        expect(r.dettaglio).toContain('PGRST203')
        expect(r.dettaglio).not.toContain('testo che non deve uscire')
    })

    it('una risposta illeggibile: degradato', async () => {
        const c = client({ salute_anno: () => ({ data: { sedi_senza_successivo: 'molte' }, error: null }) })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'risposta di salute_anno illeggibile' })
    })

    it('un client che lancia: degradato, mai giu', async () => {
        const c = client({
            salute_anno: () => {
                throw new Error('rete')
            },
        })
        expect((await controlloAnno(c, ADESSO)).esito).toBe('degradato')
    })
})

describe('anno-invarianti · i dati dell’anno sono a posto? (non accende nessun allarme)', () => {
    it('zero invarianti: ok', async () => {
        const c = conSalute({ sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 0 })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({ nome: 'anno-invarianti', esito: 'ok' })
    })

    it('tre invarianti non a zero: degradato, col solo numero', async () => {
        const c = conSalute({ sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 3 })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({
            nome: 'anno-invarianti',
            esito: 'degradato',
            dettaglio: '3 invarianti dell’anno non a zero',
        })
    })

    it('una sola invariante: singolare', async () => {
        const c = conSalute({ sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 1 })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({ dettaglio: '1 invariante dell’anno non a zero' })
    })

    it('il ritardo dell’anno successivo non lo riguarda', async () => {
        const c = conSalute({ sedi_senza_successivo: 2, in_ritardo_giorni: 9, invarianti_non_zero: 0 })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({ esito: 'ok' })
    })

    it('funzione assente → non degradato e log `info`', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(10 * MIN))
        const c = client({ salute_anno: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({ esito: 'ok', dettaglio: 'salute_anno non ancora installata (PGRST202)' })
        expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
            'rpc',
            'info',
            expect.objectContaining({ operazione: 'health:salute_anno', esito: 'rpc-non-ancora-installata' }),
        )
    })
})

describe('i due controlli stanno nei livelli giusti', () => {
    const risposte = { salute_anno: () => ({ data: { sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 0 }, error: null }) }

    it('`eseguiSalute` ha `anno` e non ha `anno-invarianti`', async () => {
        const s = await eseguiSalute(client(risposte), { adesso: ADESSO, ambiente: 'production' })
        const nomi = s.controlli.map((x) => x.nome)
        expect(nomi).toContain('anno')
        expect(nomi).not.toContain('anno-invarianti')
        expect(s.controlli.find((x) => x.nome === 'anno')).toMatchObject({ esito: 'ok' })
    })

    it('`eseguiQualita` ha `anno-invarianti` e non ha `anno`', async () => {
        const s = await eseguiQualita(client(risposte))
        const nomi = s.controlli.map((x) => x.nome)
        expect(nomi).toContain('anno-invarianti')
        expect(nomi).not.toContain('anno')
    })
})

describe('i due job dell\'anno: tutti e due sorvegliati dal battito', () => {
    it('`anni-tick` è in JOB_CRON con finestra 3 ore e non è più fra i non sorvegliati', () => {
        const voce = JOB_CRON.find((j) => j.nome === 'anni-tick')
        expect(voce).toBeDefined()
        expect(voce!.finestraMs).toBe(3 * 60 * 60 * 1000)
        expect(JOB_CRON_NON_SORVEGLIATI.some((j) => j.nome === 'anni-tick')).toBe(false)
    })

    it('`anno-invarianti` è in JOB_CRON con finestra di 26 ore (il battito c\'è dalla 4.8) e non è più fra i non sorvegliati', () => {
        const voce = JOB_CRON.find((j) => j.nome === 'anno-invarianti')
        expect(voce).toBeDefined()
        expect(voce!.finestraMs).toBe(26 * 60 * 60 * 1000)
        expect(JOB_CRON_NON_SORVEGLIATI.some((j) => j.nome === 'anno-invarianti')).toBe(false)
    })
})
