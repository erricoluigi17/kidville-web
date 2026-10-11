// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'
import {
    controlloCodeArretrate,
    MINUTI_ALLARME_PUSH,
    MINUTI_ALLARME_PRESA,
    MINUTI_ALLARME_DIGEST,
    MINUTI_ALLARME_NEWS,
    GIORNI_GUARDIA_DIGEST,
} from '@/lib/health/controlli'

/**
 * LA SONDA SULLE CODE CHE NON SI SVUOTANO (fase 8 della roadmap di robustezza).
 *
 * Il battito dice se un cron è PARTITO; questa sonda dice se la sua coda si è SVUOTATA. Ogni
 * caso qui sotto ha il suo gemello appena sotto la soglia: una sonda verde su tutto non prova
 * niente, una rossa su tutto è un allarme che viene spento.
 *
 * Il database è il finto del repo, che applica davvero i filtri (`.or` annidati compresi).
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-11T10:00:00.000Z')
const fa = (ms: number) => new Date(ADESSO - ms).toISOString()
const fra = (ms: number) => new Date(ADESSO + ms).toISOString()

function dbVuoto(): DBFinto {
    return { notifiche: [], news_digest_edizioni: [], news_posts: [] }
}

async function sonda(d: DBFinto, errori: Record<string, ErrorePostgrest> = {}) {
    return controlloCodeArretrate(creaFintoSupabase(d, [], { errori }) as unknown as SupabaseClient, ADESSO)
}

describe('code-arretrate — il caso sano', () => {
    it('code vuote ⇒ ok, «nessun arretrato»', async () => {
        const c = await sonda(dbVuoto())
        expect(c).toMatchObject({ nome: 'code-arretrate', esito: 'ok', dettaglio: 'nessun arretrato' })
    })

    it('il lavoro normale in corso NON è un arretrato: push appena create, programmate nel futuro, prese vive, già spedite', async () => {
        const d = dbVuoto()
        d.notifiche = [
            { id: 'n1', push_inviata_il: null, invio_programmato_il: null, creato_il: fa(5 * MIN) },
            { id: 'n2', push_inviata_il: null, invio_programmato_il: fra(60 * MIN), creato_il: fa(120 * MIN) },
            { id: 'n3', push_inviata_il: fa(1 * MIN), push_presa_scade_il: fra(4 * MIN), creato_il: fa(90 * MIN) },
            { id: 'n4', push_inviata_il: fa(200 * MIN), push_presa_scade_il: null, creato_il: fa(300 * MIN) },
        ]
        d.news_digest_edizioni = [{ id: 'e1', inviata_il: null, presa_scade_il: fra(3 * MIN) }]
        d.news_posts = [{ id: 'p1', stato: 'programmata', programmata_il: fra(10 * MIN) }]
        expect((await sonda(d)).esito).toBe('ok')
    })
})

describe('code-arretrate — ogni coda ferma si vede, e appena sotto la soglia no', () => {
    it(`push mai presa da oltre ${MINUTI_ALLARME_PUSH} min (senza programmazione: conta la creazione)`, async () => {
        const d = dbVuoto()
        d.notifiche = [{ id: 'n1', push_inviata_il: null, invio_programmato_il: null, creato_il: fa((MINUTI_ALLARME_PUSH + 1) * MIN) }]
        const c = await sonda(d)
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('1 push maturate e non prese')
        d.notifiche[0].creato_il = fa((MINUTI_ALLARME_PUSH - 1) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
    })

    it('push programmata e maturata da oltre la soglia (conta la programmazione, non la creazione)', async () => {
        const d = dbVuoto()
        d.notifiche = [{ id: 'n1', push_inviata_il: null, invio_programmato_il: fa((MINUTI_ALLARME_PUSH + 5) * MIN), creato_il: fa(600 * MIN) }]
        expect((await sonda(d)).esito).toBe('degradato')
        d.notifiche[0].invio_programmato_il = fa((MINUTI_ALLARME_PUSH - 5) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
    })

    it(`presa push scaduta da oltre ${MINUTI_ALLARME_PRESA} min e mai chiusa: il bidello non passa`, async () => {
        const d = dbVuoto()
        d.notifiche = [{ id: 'n1', push_inviata_il: fa(20 * MIN), push_presa_scade_il: fa((MINUTI_ALLARME_PRESA + 1) * MIN), creato_il: fa(25 * MIN) }]
        const c = await sonda(d)
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('prese push scadute')
        d.notifiche[0].push_presa_scade_il = fa((MINUTI_ALLARME_PRESA - 1) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
    })

    it(`edizione del digest interrotta e non ripresa da oltre ${MINUTI_ALLARME_DIGEST} min; oltre ${GIORNI_GUARDIA_DIGEST} giorni non suona più`, async () => {
        const d = dbVuoto()
        d.news_digest_edizioni = [{ id: 'e1', inviata_il: null, presa_scade_il: fa((MINUTI_ALLARME_DIGEST + 1) * MIN) }]
        const c = await sonda(d)
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('edizioni del digest interrotte')
        d.news_digest_edizioni[0].presa_scade_il = fa((MINUTI_ALLARME_DIGEST - 1) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
        d.news_digest_edizioni[0].presa_scade_il = fa((GIORNI_GUARDIA_DIGEST * 24 * 60 + 1) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
        // inviata: non è un arretrato, qualunque sia la presa
        d.news_digest_edizioni[0] = { id: 'e1', inviata_il: fa(MIN), presa_scade_il: fa(60 * MIN) }
        expect((await sonda(d)).esito).toBe('ok')
    })

    it(`news programmata e non pubblicata da oltre ${MINUTI_ALLARME_NEWS} min`, async () => {
        const d = dbVuoto()
        d.news_posts = [{ id: 'p1', stato: 'programmata', programmata_il: fa((MINUTI_ALLARME_NEWS + 1) * MIN) }]
        const c = await sonda(d)
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('news programmate non pubblicate')
        d.news_posts[0].programmata_il = fa((MINUTI_ALLARME_NEWS - 1) * MIN)
        expect((await sonda(d)).esito).toBe('ok')
        // già pubblicata: non è più in coda
        d.news_posts[0] = { id: 'p1', stato: 'pubblicata', programmata_il: fa(600 * MIN) }
        expect((await sonda(d)).esito).toBe('ok')
    })

    it('più code ferme insieme: le dice tutte, coi conteggi', async () => {
        const d = dbVuoto()
        d.notifiche = [
            { id: 'n1', push_inviata_il: null, invio_programmato_il: null, creato_il: fa(60 * MIN) },
            { id: 'n2', push_inviata_il: null, invio_programmato_il: null, creato_il: fa(90 * MIN) },
        ]
        d.news_posts = [{ id: 'p1', stato: 'programmata', programmata_il: fa(60 * MIN) }]
        const c = await sonda(d)
        expect(c.dettaglio).toContain('2 push maturate')
        expect(c.dettaglio).toContain('1 news programmate')
    })
})

describe('code-arretrate — letture cadute e database non migrato', () => {
    it('🔴 una lettura caduta NON è «zero arretrati»: degradato col codice', async () => {
        const c = await sonda(dbVuoto(), { news_posts: { code: '57014', message: 'canceling statement due to statement timeout' } })
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe('news 57014')
    })

    it('colonna o tabella assente (CI non migrata) ⇒ ok, con la nota: un allarme che suona da solo viene spento', async () => {
        const c = await sonda(dbVuoto(), {
            news_digest_edizioni: { code: '42703', message: 'column news_digest_edizioni.presa_scade_il does not exist' },
        })
        expect(c.esito).toBe('ok')
        expect(c.dettaglio).toBe('nessun arretrato; digest non installato (42703)')
    })

    it('nel dettaglio solo conteggi e codici: mai il messaggio di PostgREST', async () => {
        const c = await sonda(dbVuoto(), { notifiche: { code: '42501', message: 'permission denied for table notifiche' } })
        expect(c.dettaglio).not.toContain('permission denied')
        expect(c.dettaglio).toContain('42501')
    })
})
