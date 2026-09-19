import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LOCK — il promemoria delle adesioni NON interroga il database una volta per
 * FAMIGLIA, e nemmeno una volta per RISPOSTA.
 *
 * Gemello di `__tests__/api/avvisi-niente-n-piu-uno.test.ts`, e per la stessa
 * ragione misurata il 2026-08-03: una N+1 non si vede col cronometro quando i
 * numeri sono piccoli, e diventa un incidente quando crescono. Qui i numeri che
 * crescono sono le FAMIGLIE — a Giugliano i genitori distinti sono 345 (misurato
 * il 2026-09-08) — e la scansione gira di notte, senza nessuno a guardarla.
 *
 * ── IL BUDGET DICHIARATO ────────────────────────────────────────────────────
 *
 *   2 fisse  +  3 per AVVISO  —  e MAI una per famiglia.
 *
 *   fisse:      `admin_settings` (tutte le sedi insieme) · `avvisi`
 *   per avviso: i destinatari · `avvisi_risposte` (chi ha già risposto) ·
 *               `notifiche` (chi ha già ricevuto il promemoria)
 *
 * I destinatari NON sono una `from(…)` di questo modulo: li risolve
 * `genitoriDiScuola`, che ha il proprio contratto («3 query fisse, mai N+1») e il
 * proprio test. Perciò qui si contano DUE cose separate — le `from(…)` del
 * modulo e le CHIAMATE al risolutore — e si asserisce su entrambe: sommarle in
 * un numero solo renderebbe invisibile una regressione che sposta il lavoro da
 * una parte all'altra.
 *
 * ── LA PROVA CHE IL LOCK È VIVO ─────────────────────────────────────────────
 *
 * Il file gira lo STESSO scenario con 200 e con 201 famiglie. Un tetto assoluto
 * da solo non basterebbe: è il confronto fra i due giri a dire che il conteggio
 * non dipende dalle famiglie. (Provato a mano il 2026-09-19 spostando la lettura
 * di `notifiche` dentro un `for` sui destinatari → ROSSO su entrambe le
 * asserzioni, con 200 e 402 letture.)
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const trigger = vi.hoisted(() => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/triggers', () => trigger)

const destinatari = vi.hoisted(() => ({
    genitoriDiAlunni: vi.fn(async () => [] as string[]),
    genitoriDiClassi: vi.fn(async () => [] as string[]),
    genitoriDiScuola: vi.fn(async () => [] as string[]),
    staffScuola: vi.fn(async () => [] as string[]),
}))
vi.mock('@/lib/notifiche/destinatari', () => destinatari)

import { promemoriaAdesioni } from '@/lib/avvisi/promemoria-adesioni'

const SEDE = '11111111-1111-1111-1111-11111111000a'
/** Le 09:00 italiane, lontano dai due giorni di cambio ora. */
const ADESSO = '2026-09-21T07:00:00.000Z'

/** Quante `from(tabella)` ha fatto il modulo, per tabella. */
let query: Record<string, number> = {}
let avvisi: Array<Record<string, unknown>> = []
let risposte: Array<Record<string, unknown>> = []

function client() {
    return {
        from(tabella: string) {
            query[tabella] = (query[tabella] ?? 0) + 1
            const dati = (): Array<Record<string, unknown>> => {
                if (tabella === 'admin_settings') {
                    return [{ scuola_id: SEDE, avvisi_config: { promemoria_giorni_prima: 7 } }]
                }
                if (tabella === 'avvisi') return avvisi
                if (tabella === 'avvisi_risposte') return risposte
                return [] // `notifiche`: nessun promemoria già inviato
            }
            const b: Record<string, unknown> = {}
            for (const m of ['select', 'eq', 'neq', 'not', 'is', 'or', 'order', 'limit', 'in', 'gt', 'gte', 'lt', 'lte']) {
                b[m] = () => b
            }
            b.range = async (da: number, a: number) => {
                const tutte = dati()
                return { data: tutte.slice(da, a + 1), count: tutte.length, error: null }
            }
            b.maybeSingle = async () => ({ data: dati()[0] ?? null, error: null })
            b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                Promise.resolve({ data: dati(), error: null, count: dati().length }).then(ok, ko)
            return b
        },
    }
}

/** N avvisi di adesione in finestra, tutti della stessa sede. */
function preparaAvvisi(n: number) {
    avvisi = Array.from({ length: n }, (_, i) => ({
        id: `22222222-2222-2222-2222-00000000000${i}`,
        titolo: `Gita ${i}`,
        tipo: 'adesione',
        scuola_id: SEDE,
        target_scope: 'globale',
        target_classes: null,
        // Tre giorni civili: dentro la finestra da 7 della sede.
        scadenza_adesione: '2026-09-24T16:00:00.000Z',
    }))
}

/** Le famiglie, come le restituisce `genitoriDiScuola`. */
function preparaFamiglie(n: number) {
    destinatari.genitoriDiScuola.mockResolvedValue(
        Array.from({ length: n }, (_, i) => `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`),
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    query = {}
    risposte = []
    trigger.notificaEvento.mockResolvedValue(undefined)
})

describe('promemoriaAdesioni — il conteggio delle query', () => {
    it('3 avvisi e 200 famiglie: 2 letture fisse + 2 per avviso, e 1 risoluzione destinatari per avviso', async () => {
        preparaAvvisi(3)
        preparaFamiglie(200)

        const esito = await promemoriaAdesioni(client() as never, ADESSO)

        expect(esito).toEqual({ inviati: 600, saltata: false })

        const totale = Object.values(query).reduce((a, b) => a + b, 0)
        // Il tetto DICHIARATO, e si asserisce su quello assoluto: un tetto
        // relativo («meno di prima») lascerebbe passare una regressione che
        // moltiplica per dieci restando sotto il vecchio numero.
        expect(totale).toBeLessThanOrEqual(2 + 3 * 3)
        // E il numero ESATTO, così che anche un passo in più — non solo una N+1 —
        // debba essere una decisione scritta invece di una deriva.
        expect(query).toEqual({ admin_settings: 1, avvisi: 1, avvisi_risposte: 3, notifiche: 3 })
        // La terza «per avviso» del budget: la risoluzione dei destinatari, che
        // NON è una from() di questo modulo. Contarla separatamente impedisce a
        // una regressione di nascondersi spostando il lavoro da una parte all'altra.
        expect(destinatari.genitoriDiScuola).toHaveBeenCalledTimes(3)
        expect(trigger.notificaEvento).toHaveBeenCalledTimes(3)
    })

    it('🔑 aggiungere UNA famiglia non cambia nemmeno una query', async () => {
        preparaAvvisi(3)
        preparaFamiglie(200)
        await promemoriaAdesioni(client() as never, ADESSO)
        const conDuecento = { ...query }

        query = {}
        vi.clearAllMocks()
        trigger.notificaEvento.mockResolvedValue(undefined)
        preparaAvvisi(3)
        preparaFamiglie(201)
        await promemoriaAdesioni(client() as never, ADESSO)

        expect(query).toEqual(conDuecento)
        expect(destinatari.genitoriDiScuola).toHaveBeenCalledTimes(3)
    })

    it('le RISPOSTE già arrivate non aggiungono query, e tolgono davvero i destinatari', async () => {
        // 150 famiglie su 200 hanno già risposto: il conteggio delle query non si
        // muove (si leggono in blocco), ma il numero degli invii sì — altrimenti
        // questo test misurerebbe solo il finto.
        preparaAvvisi(1)
        preparaFamiglie(200)
        risposte = Array.from({ length: 150 }, (_, i) => ({
            parent_id: `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`,
        }))

        const esito = await promemoriaAdesioni(client() as never, ADESSO)

        expect(query).toEqual({ admin_settings: 1, avvisi: 1, avvisi_risposte: 1, notifiche: 1 })
        expect(esito.inviati).toBe(50)
    })

    /**
     * 🔑 LA SECONDA PAGINA, CHE NON ERA MAI STATA PERCORSA.
     *
     * `parentIdsCheHannoRisposto` è paginata — `count: 'exact'`, avanzamento per
     * `data.length`, tetto a `MAX_PAGINE` — perché PostgREST tronca eccome: su
     * Supabase `db-max-rows` vale 1000 di default. Ma ogni test di questo file
     * girava con meno di 1000 risposte, quindi il ciclo usciva SEMPRE alla prima
     * pagina: la paginazione era codice mai eseguito.
     *
     * Una pagina persa qui non produce un numero più basso, produce un SOLLECITO
     * SPEDITO A CHI HA GIÀ ADERITO. Il numero degli invii è l'unica asserzione che
     * lo vede: il conteggio delle query, da solo, sarebbe verde anche se la
     * seconda pagina venisse buttata via.
     *
     * (La pagina VUOTA con il totale ancora alto — l'altro ramo, quello che deve
     * LANCIARE — sta in `__tests__/api/avvisi-promemoria-adesioni.test.ts`, dove
     * si può osservare il 500 e il battito `giro-incompleto`.)
     */
    it('🔑 1.500 risposte = DUE pagine, e l\'insieme che ne esce è COMPLETO', async () => {
        preparaAvvisi(1)
        preparaFamiglie(1600)
        risposte = Array.from({ length: 1500 }, (_, i) => ({
            parent_id: `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`,
        }))

        const esito = await promemoriaAdesioni(client() as never, ADESSO)

        // DUE letture di `avvisi_risposte`, e non viola il budget: quello è «mai
        // una query per FAMIGLIA», non «mai una query per pagina». 1.500 righe a
        // 1.000 per pagina fanno due giri, e farebbero due giri anche con 1.500
        // famiglie o con 15.000.
        expect(query).toEqual({ admin_settings: 1, avvisi: 1, avvisi_risposte: 2, notifiche: 1 })
        // 1.600 famiglie − 1.500 che hanno già risposto = 100. Perdendo la seconda
        // pagina resterebbero 600: cinquecento solleciti a chi ha GIÀ aderito.
        expect(esito.inviati).toBe(100)
    })
})
