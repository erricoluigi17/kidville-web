// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type RispostaRpc, type Riga } from '../fixtures/finto-supabase'
import { controlloAnno, controlloAnnoInvarianti } from '@/lib/health/controlli'
import { logEvento } from '@/lib/logging/logger'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * COMPITO 4.9.2 · LE DUE CHIAVI NUOVE DI `salute_anno()` (M49b) NEL CONTROLLO `anno`.
 *
 * `passaggio_da_fare` (il passaggio non fatto a 7 giorni o meno dall'inizio dell'anno nuovo) e `guardia_spenta_vicina` (la guardia
 * spenta a 30 giorni o meno dalla chiusura, OPPURE con l'anno rimasto `in_chiusura` oltre la `fine`: M1 del giro 3). I giorni li conta il database (`anno-passaggio-da-fare.test.ts`: 8 → 0, 7 e 6 → 1; 31 → 0,
 * 30 e 29 → 1); qui si prova solo che il controllo legge i numeri giusti e dice la frase giusta. Mai `giu`: `degradato`.
 * Le chiavi assenti (la funzione di prima: il merge a metà, o il database della CI) sono come prima e lasciano una riga `info`.
 */

const ADESSO = Date.parse('2027-08-25T10:00:00.000Z')

type Salute = Record<string, number | string | null>
const BASE = { sedi_senza_successivo: 0, in_ritardo_giorni: 0, invarianti_non_zero: 0 }

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

describe('anno · il passaggio e la guardia', () => {
    it('chiavi assenti (la funzione di prima): ok, come prima, e una riga info che dice perché', async () => {
        const c = conSalute({ ...BASE })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ nome: 'anno', esito: 'ok', dettaglio: 'anno successivo in regola' })
        expect(logEvento).toHaveBeenCalledWith('rpc', 'info', expect.objectContaining({ esito: 'salute-anno-senza-chiavi-4-9' }))
    })

    it('chiavi presenti a zero: ok e nessuna riga', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 0, guardia_spenta_vicina: 0 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'ok' })
        expect(logEvento).not.toHaveBeenCalled()
    })

    it('il passaggio da fare, senza sapere se l’anno è già cominciato: frase vera in tutti e due i casi, mai «entro 7 giorni» e basta', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 2, guardia_spenta_vicina: 0 })
        const r = await controlloAnno(c, ADESSO)
        expect(r.esito).toBe('degradato')
        expect(r.dettaglio).toBe('2 sedi con il passaggio d’anno da fare (a meno di 7 giorni dall’inizio dell’anno nuovo, o già cominciato)')
    })

    it('(chiusura A) la salute NON scrive righe `error` (le scrive il giro orario di anni_tick): troppe letture peggiorerebbero tasso-errore', async () => {
        await controlloAnno(conSalute({ ...BASE, passaggio_da_fare: 2, guardia_spenta_vicina: 0 }), ADESSO)
        expect(vi.mocked(logEvento).mock.calls.filter((c) => c[1] === 'error')).toHaveLength(0)
    })

    it('una sede sola: «1 sede», non «1 sedi»', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 1, guardia_spenta_vicina: 0 })
        expect((await controlloAnno(c, ADESSO)).dettaglio).toMatch(/^1 sede con il passaggio/)
    })

    it('con `passaggio_iniziato`: prima dell’inizio «da fare entro 7 giorni»', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 2, passaggio_iniziato: 0, guardia_spenta_vicina: 0 })
        expect((await controlloAnno(c, ADESSO)).dettaglio).toBe('2 sedi con il passaggio d’anno da fare entro 7 giorni')
    })

    it('con `passaggio_iniziato`: dopo l’inizio la frase NON dice «entro 7 giorni» e dice che l’anno è cominciato', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 2, passaggio_iniziato: 2, guardia_spenta_vicina: 0 })
        const r = await controlloAnno(c, ADESSO)
        expect(r.dettaglio).toBe('2 sedi con l’anno nuovo già cominciato e il passaggio d’anno non fatto')
        expect(r.dettaglio).not.toContain('entro 7 giorni')
    })

    it('con `passaggio_iniziato`: metà e metà, le due frasi insieme', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 3, passaggio_iniziato: 1, guardia_spenta_vicina: 0 })
        expect((await controlloAnno(c, ADESSO)).dettaglio).toBe(
            '1 sede con l’anno nuovo già cominciato e il passaggio d’anno non fatto; 2 sedi con il passaggio d’anno da fare entro 7 giorni',
        )
    })

    it('`passaggio_iniziato` storto (negativo, testo) o più grande di `passaggio_da_fare`: risposta illeggibile', async () => {
        for (const storto of [-1, 'molte', 5] as const) {
            const c = conSalute({ ...BASE, passaggio_da_fare: 2, passaggio_iniziato: storto as never, guardia_spenta_vicina: 0 })
            expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'risposta di salute_anno illeggibile' })
        }
    })

    it('la guardia spenta (anno da chiudere o vicino alla chiusura): degradato, col numero e il rimedio', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 0, guardia_spenta_vicina: 3 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: '3 sedi con l’anno da chiudere, o vicino alla chiusura, e la guardia spenta: lo stato dell’anno non cambia finché non la si accende',
        })
    })

    it('una sola sede: tutto al singolare (guardia spenta e ritardo dell’anno successivo)', async () => {
        const uno = conSalute({ ...BASE, passaggio_da_fare: 0, guardia_spenta_vicina: 1 })
        expect(await controlloAnno(uno, ADESSO)).toMatchObject({
            dettaglio: '1 sede con l’anno da chiudere, o vicino alla chiusura, e la guardia spenta: lo stato dell’anno non cambia finché non la si accende',
        })
        const ritardo = conSalute({ sedi_senza_successivo: 1, in_ritardo_giorni: 2, invarianti_non_zero: 0, passaggio_da_fare: 0, guardia_spenta_vicina: 0 })
        expect(await controlloAnno(ritardo, ADESSO)).toMatchObject({ dettaglio: '1 sede senza l’anno successivo, in ritardo fino a 2 giorni' })
    })

    it('tutte e due: vince il passaggio (è il più grave: l’anno sta per cominciare)', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 1, guardia_spenta_vicina: 1 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({ dettaglio: expect.stringContaining('passaggio d’anno') })
    })

    it('il ritardo dell’anno successivo resta quello di prima e vince su tutte e due', async () => {
        const c = conSalute({ sedi_senza_successivo: 3, in_ritardo_giorni: 1, invarianti_non_zero: 0, passaggio_da_fare: 1, guardia_spenta_vicina: 1 })
        expect(await controlloAnno(c, ADESSO)).toMatchObject({
            esito: 'degradato', dettaglio: '3 sedi senza l’anno successivo, in ritardo fino a 1 giorni',
        })
    })

    it('una chiave presente ma storta (negativa, testo): risposta illeggibile, degradato', async () => {
        for (const storta of [-1, 'molte', null] as const) {
            const c = conSalute({ ...BASE, passaggio_da_fare: storta as never, guardia_spenta_vicina: 0 })
            expect(await controlloAnno(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'risposta di salute_anno illeggibile' })
        }
    })

    it('le invarianti NON si mescolano: il controllo `anno-invarianti` ignora le due chiavi nuove', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 5, guardia_spenta_vicina: 5 })
        expect(await controlloAnnoInvarianti(c, ADESSO)).toMatchObject({ nome: 'anno-invarianti', esito: 'ok' })
    })

    it('la risposta non porta nomi né uuid: il dettaglio ha solo il numero', async () => {
        const c = conSalute({ ...BASE, passaggio_da_fare: 4, guardia_spenta_vicina: 0 })
        const r = await controlloAnno(c, ADESSO)
        expect(r.dettaglio).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
    })
})
