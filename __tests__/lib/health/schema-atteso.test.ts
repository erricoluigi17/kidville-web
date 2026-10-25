// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { controlloSchema, TABELLE_ATTESE } from '@/lib/health/controlli'

/**
 * `schema-atteso` PROVATO CON IL CLIENT VERO DI supabase-js, CON UN `fetch` FINTO.
 *
 * Il finto client dei test (`__tests__/fixtures/finto-supabase.ts`) restituisce l'errore che gli si
 * dice di restituire, qualunque sia la forma della richiesta: non può vedere che una HEAD senza
 * corpo perde il `PGRST205`. Qui si usa la libreria vera, e il `fetch` risponde come PostgREST:
 * 404 con il corpo JSON a una GET, 404 senza corpo a una HEAD (una HEAD un corpo non ce l'ha).
 */

interface Chiamata {
    verbo: string
    url: URL
    prefer: string | null
}

interface Risposta {
    stato: number
    corpo?: unknown
}

const RIGA = [{ id: '00000000-0000-4000-8000-000000000001' }]

function tabellaDi(c: Chiamata): string {
    return c.url.pathname.replace('/rest/v1/', '')
}

function client(risposta: (c: Chiamata) => Risposta | Promise<Risposta>, chiamate: Chiamata[] = []): SupabaseClient {
    const fetchFinto = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const c: Chiamata = {
            verbo: (init?.method ?? 'GET').toUpperCase(),
            url: new URL(input instanceof Request ? input.url : String(input)),
            prefer: new Headers(init?.headers).get('Prefer'),
        }
        chiamate.push(c)
        const r = await risposta(c)
        const conCorpo = c.verbo !== 'HEAD' && r.corpo !== undefined
        return new Response(conCorpo ? JSON.stringify(r.corpo) : null, {
            status: r.stato,
            headers: conCorpo ? { 'Content-Type': 'application/json' } : {},
        })
    }
    // `accessToken` tiene fuori auth-js (sessioni, lock, timer): qui si prova solo PostgREST.
    return createClient('https://finto.supabase.co', 'chiave-fittizia', {
        accessToken: async () => 'gettone-finto',
        global: { fetch: fetchFinto },
    })
}

afterEach(() => {
    vi.useRealTimers()
})

describe('schema-atteso con il client vero', () => {
    it('una tabella assente si vede: PostgREST risponde 404 PGRST205 e lo stato è giu', async () => {
        const c = client((ch) =>
            tabellaDi(ch) === 'avvisi'
                ? { stato: 404, corpo: { code: 'PGRST205', message: 'Could not find the table', details: null, hint: null } }
                : { stato: 200, corpo: RIGA },
        )

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ nome: 'schema-atteso', esito: 'giu', dettaglio: 'tabelle assenti: avvisi' })
    })

    it('una GET per tabella, con `select=id` e `limit=1`, senza conteggio', async () => {
        const chiamate: Chiamata[] = []
        const c = client(() => ({ stato: 200, corpo: RIGA }), chiamate)

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ esito: 'ok', dettaglio: '5 tabelle presenti' })
        expect(chiamate.map(tabellaDi).sort()).toEqual([...TABELLE_ATTESE].sort())
        for (const ch of chiamate) {
            expect(ch.verbo).toBe('GET')
            expect(ch.url.searchParams.get('select')).toBe('id')
            expect(ch.url.searchParams.get('limit')).toBe('1')
            expect(ch.prefer ?? '').not.toContain('count=')
        }
    })

    it('cinque letture da 1,5 s stanno sotto il tetto di 2 s: girano in parallelo', async () => {
        vi.useFakeTimers()
        const c = client(() => new Promise<Risposta>((r) => setTimeout(() => r({ stato: 200, corpo: RIGA }), 1_500)))

        const promessa = controlloSchema(c)
        await vi.advanceTimersByTimeAsync(1_500)

        expect(await promessa).toMatchObject({ esito: 'ok', dettaglio: '5 tabelle presenti' })
    })

    it('un database che non risponde è degradato, non giù: lentezza non è assenza', async () => {
        vi.useFakeTimers()
        const c = client(() => new Promise<Risposta>(() => undefined))

        const promessa = controlloSchema(c)
        await vi.advanceTimersByTimeAsync(2_000)

        expect(await promessa).toMatchObject({ esito: 'degradato', dettaglio: 'oltre il tetto di 2000 ms' })
    })

    it('una tabella illeggibile resta giu, con il solo codice', async () => {
        const c = client((ch) =>
            tabellaDi(ch) === 'pagamenti'
                ? { stato: 500, corpo: { code: 'XX000', message: 'dettaglio interno da non rilanciare', details: null, hint: null } }
                : { stato: 200, corpo: RIGA },
        )

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ esito: 'giu', dettaglio: 'tabelle illeggibili: pagamenti:XX000' })
    })
})
