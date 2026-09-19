import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA QUARTA SCANSIONE DI `notifiche-promemoria`: «mancano N giorni per aderire».
 *
 * ── PERCHÉ IL FINTO DATABASE DI QUESTO FILE HA UNO STATO ────────────────────
 *
 * `cron-battito.test.ts` usa code FIFO di risposte, che bastano a misurare i
 * BATTITI (un `{ error }` entra, un `esito` esce). Qui no: la cosa da provare è
 * che **due giri consecutivi mandano un promemoria solo**, e quella proprietà
 * esiste soltanto se il secondo giro LEGGE la riga che il primo ha SCRITTO. Con
 * un finto piatto il test sarebbe verde con e senza la deduplica — la prima
 * delle cinque forme di verde falso di `.claude/rules/test.md`. Perciò qui c'è
 * un piccolo database in memoria: `notificaEvento` ci scrive le notifiche, e la
 * query di deduplica le rilegge.
 *
 * ── LE TRE PROVE DI ROTTURA, ESEGUITE ───────────────────────────────────────
 *
 * Un lock mai visto fallire non è un lock. Provate a mano il 2026-09-19, ogni
 * esito OSSERVATO e non previsto:
 *
 *  1. `giaRicordati` forzato a `new Set()` (cioè la deduplica tolta, che è anche
 *     ciò che produrrebbe una lettura fallita e ignorata) → ROSSO su «due giri,
 *     un solo invio»: `notificaEvento` chiamata 2 volte invece di 1.
 *  2. `nMax` usato come soglia al posto del `giorni` della sede → ROSSO su «due
 *     sedi, N diversi»: la famiglia della sede da 3 giorni riceve il promemoria
 *     della finestra da 7.
 *  3. 🔑 `debounce: true` aggiunto alla chiamata a `notificaEvento` → i due test
 *     della DEDUPLICA restano **VERDI**, identici a prima. È il punto: chi un
 *     giorno «aggiusterà» il dedup aggiungendo il debounce non vedrà nessun test
 *     diventare verde, perché non ne era rosso nessuno. Il debounce cancella le
 *     notifiche PENDING con lo stesso `tipo+entita_id` prima di riaccodare —
 *     collassa una raffica dentro la finestra di buffer, e qui `bufferMin` vale
 *     0, quindi non c'è mai niente da collassare. L'unico rosso è il test che si
 *     chiama «NIENTE debounce», che esiste apposta per vietarlo.
 *
 * ── E UN RISULTATO ONESTO SUL `.gte('creato_il', cutoff)` ───────────────────
 *
 * Toglierlo NON fa diventare rosso «due giri, un solo invio», e va detto invece
 * di lasciarlo credere: togliere un filtro ALLARGA l'insieme delle notifiche già
 * viste, quindi deduplica di più, non di meno. Quella clausola serve a un'altra
 * cosa — riaprire il sollecito quando la segreteria SPOSTA IN AVANTI la scadenza
 * — ed è il test «scadenza spostata in avanti» a pinnarla: quello sì diventa
 * rosso se il `.gte` sparisce.
 */

// ── Le spie sul logger (il logger vero è muto sotto vitest) ──────────────────
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

// ── Il finto database, con stato ─────────────────────────────────────────────
const db = vi.hoisted(() => {
    const state = {
        tabelle: {} as Record<string, Array<Record<string, unknown>>>,
        /** Errori per tabella, in CODA: uno per lettura, nell'ordine in cui arrivano. */
        erroriCoda: {} as Record<string, Array<unknown>>,
        usate: {} as Record<string, number>,
        /** Ogni `from(tabella)`, in ordine: è il dato del test di budget. */
        from: [] as string[],
        /**
         * Spegne, nel finto, TUTTI i filtri su queste colonne. Serve a un caso
         * solo — l'avviso di adesione senza `scadenza_adesione` — e la ragione è
         * che il ramo in memoria che lo salta esiste proprio come GEMELLO dei
         * filtri server (`.not(…,'is',null)` + `.gte` + `.lte`): con quei filtri
         * attivi la riga non arriva mai, nel finto come in PostgREST. Per
         * raggiungere il ramo bisogna simulare l'ambiente contro cui è stato
         * scritto — un successore che toglie il filtro, un backend che lo ignora,
         * una colonna che su quell'ambiente si comporta diversamente.
         */
        colonneSenzaFiltro: [] as string[],
        /**
         * Il `count` che il finto DICHIARA per una tabella, al posto di quello
         * che ha davvero.
         *
         * Serve a una cosa sola, e non si può ottenere altrimenti: su PostgREST
         * `count: 'exact'` è il totale VERO lato server e NON è vincolato a
         * quante righe la pagina restituisce. Una riga cancellata fra il
         * conteggio e la pagina, o il `db-max-rows` che tronca, producono
         * esattamente questo — una pagina più corta del totale, e nel caso
         * peggiore una pagina VUOTA con il totale ancora alto. Il finto, che
         * conta ciò che restituisce, non saprebbe mai produrlo da sé: senza
         * questa manopola il `throw` sulla pagina vuota non può diventare rosso,
         * cioè non è un lock.
         */
        conteggioDichiarato: {} as Record<string, number>,
    }

    function passa(riga: Record<string, unknown>, filtri: Array<{ op: string; col: string; val: unknown }>): boolean {
        return filtri.every((f) => {
            if (state.colonneSenzaFiltro.includes(f.col)) return true
            const v = riga[f.col]
            switch (f.op) {
                case 'eq': return v === f.val
                case 'neq': return v !== f.val
                case 'is-null': return v === null || v === undefined
                case 'not-is-null': return v !== null && v !== undefined
                case 'gt': return String(v) > String(f.val)
                case 'gte': return String(v) >= String(f.val)
                case 'lt': return String(v) < String(f.val)
                case 'lte': return String(v) <= String(f.val)
                case 'in': return Array.isArray(f.val) && (f.val as unknown[]).includes(v)
                default: return true
            }
        })
    }

    function client() {
        return {
            from(tabella: string) {
                state.from.push(tabella)
                const filtri: Array<{ op: string; col: string; val: unknown }> = []
                let operazione: 'select' | 'delete' | 'update' = 'select'
                let conConteggio = false

                const b: Record<string, unknown> = {}
                const aggiungi = (op: string) => (col: string, val: unknown) => { filtri.push({ op, col, val }); return b }
                for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']) b[op] = aggiungi(op)
                b.is = (col: string, val: unknown) => { filtri.push({ op: val === null ? 'is-null' : 'eq', col, val }); return b }
                b.not = (col: string, operatore: string, val: unknown) => {
                    filtri.push({ op: operatore === 'is' && val === null ? 'not-is-null' : 'neq', col, val })
                    return b
                }
                // `.or()` non si modella: nessuna asserzione di questo file dipende da lui
                // (la scansione dei moduli, che è l'unica a usarlo, qui legge sempre zero righe).
                b.or = () => b
                b.order = () => b
                b.limit = () => b
                b.select = (_colonne?: string, opzioni?: { count?: string }) => {
                    if (opzioni?.count) conConteggio = true
                    return b
                }
                b.delete = () => { operazione = 'delete'; return b }
                b.update = () => { operazione = 'update'; return b }

                async function esegui(): Promise<{ data: unknown; count: number | null; error: unknown }> {
                    const i = state.usate[tabella] ?? 0
                    state.usate[tabella] = i + 1
                    const errore = (state.erroriCoda[tabella] ?? [])[i] ?? null
                    if (errore) return { data: null, count: null, error: errore }

                    const righe = state.tabelle[tabella] ?? []
                    const trovate = righe.filter((r) => passa(r, filtri))
                    if (operazione === 'delete') {
                        state.tabelle[tabella] = righe.filter((r) => !passa(r, filtri))
                    }
                    return { data: trovate, count: conConteggio ? trovate.length : null, error: null }
                }

                b.maybeSingle = async () => {
                    const r = await esegui()
                    return { data: ((r.data as unknown[]) ?? [])[0] ?? null, error: r.error }
                }
                b.single = b.maybeSingle
                b.range = async (da: number, a: number) => {
                    const r = await esegui()
                    if (r.error) return { data: null, count: null, error: r.error }
                    const tutte = (r.data as unknown[]) ?? []
                    const count = state.conteggioDichiarato[tabella] ?? tutte.length
                    return { data: tutte.slice(da, a + 1), count, error: null }
                }
                b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => esegui().then(ok, ko)
                return b
            },
            storage: { from: () => ({ upload: async () => ({}), remove: async () => ({ data: null, error: null }) }) },
        }
    }

    return { state, client }
})

const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

const trigger = vi.hoisted(() => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => trigger)

const destinatari = vi.hoisted(() => ({
    genitoriDiAlunni: vi.fn(async () => [] as string[]),
    genitoriDiClassi: vi.fn(async () => [] as string[]),
    genitoriDiScuola: vi.fn(async () => [] as string[]),
    staffScuola: vi.fn(async () => [] as string[]),
}))
vi.mock('@/lib/notifiche/destinatari', () => destinatari)

// La riconciliazione dell'armadietto ha il suo test (`cron-battito`): qui deve
// solo non sporcare il conteggio delle letture né i log.
const armadietto = vi.hoisted(() => ({
    riconciliaTutto: vi.fn(async () => ({ alunni: 0, aperte: 0, evase: 0 })),
}))
vi.mock('@/lib/armadietto/richieste', () => armadietto)

const settings = vi.hoisted(() => ({ getModuleConfig: vi.fn(async () => ({})), leggiModuleConfig: vi.fn(async () => ({ ok: true, config: {} })) }))
vi.mock('@/lib/settings/module-config', () => settings)

// ── Le dipendenze della sola DELETE (il «ritiro gratuito») ───────────────────
const auth = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    requireStaff: vi.fn(),
    requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => auth)
const scope = vi.hoisted(() => ({
    assertAvvisoInScope: vi.fn(async () => null),
    assertSedeRigaInScope: vi.fn(async () => null),
    scopeRigaNonRisolta: vi.fn(),
    rigaNonTrovata: vi.fn(),
}))
vi.mock('@/lib/auth/scope-avvisi', () => scope)
const rimozione = vi.hoisted(() => ({
    percorsoAllegatoAvviso: vi.fn(() => null),
    percorsoAllegatoArchiviatoAvviso: vi.fn(async () => null),
    rimuoviAllegatoAvvisoSeOrfano: vi.fn(async () => 0),
    rimuoviAllegatoNonPubblicato: vi.fn(async () => 0),
    rimuoviDalBucket: vi.fn(async () => 0),
}))
vi.mock('@/lib/allegati/rimozione', () => rimozione)
const audit = vi.hoisted(() => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/audit/scrittura', () => audit)

import { POST as promemoriaPOST } from '@/app/api/notifiche/promemoria/route'
import { DELETE as avvisoDELETE } from '@/app/api/avvisi/[id]/route'

// ── Anagrafica del banco di prova ────────────────────────────────────────────
const SEGRETO = 'test-secret'
const SEDE_A = '11111111-1111-1111-1111-11111111000a'
const SEDE_B = '11111111-1111-1111-1111-11111111000b'
const AVVISO = '22222222-2222-2222-2222-222222222221'
const P1 = '33333333-3333-3333-3333-333333333331'
const P2 = '33333333-3333-3333-3333-333333333332'
const P3 = '33333333-3333-3333-3333-333333333333'

/**
 * Le 09:00 italiane di un lunedì lontano dai due giorni di cambio ora: il fuso ha
 * il suo test (`confini-giorno`), qui non deve essere una variabile in più.
 */
const T0 = new Date('2026-09-21T07:00:00.000Z')

/** L'istante corrispondente alle 18:00 italiane del giorno civile `+g` da T0. */
function fraGiorniCivili(g: number, base: Date = T0): string {
    const d = new Date(base.getTime() + g * 86_400_000)
    // Le 16:00Z = 18:00 a Roma d'estate: dentro il giorno civile, lontano dai bordi.
    return `${d.toISOString().slice(0, 10)}T16:00:00.000Z`
}

const DB_IN_AFFANNO = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }
const COLONNA_ASSENTE = { code: '42703', message: 'column avvisi.scadenza_adesione does not exist', details: null, hint: null }

function req(secret?: string): Request {
    return new Request('http://localhost/api/notifiche/promemoria', {
        method: 'POST',
        headers: secret ? { 'x-cron-secret': secret } : {},
    })
}

function righe(livello?: string): Array<{ evento: string; livello: string; campi: Record<string, unknown> }> {
    return log.logEvento.mock.calls
        .filter((c) => livello === undefined || c[1] === livello)
        .map((c) => ({ evento: c[0] as string, livello: c[1] as string, campi: (c[2] ?? {}) as Record<string, unknown> }))
}

function battito(esito: string): Record<string, unknown> | undefined {
    return righe().find((r) => r.evento === 'cron' && r.campi.esito === esito)?.campi
}

function erroriCron(): Array<Record<string, unknown>> {
    return righe('error').filter((r) => r.evento === 'cron').map((r) => r.campi)
}

/** Gli avvisi di adesione passati a `notificaEvento`, con destinatari e corpo. */
function promemoriaInviati(): Array<{ utenteIds: string[]; corpo: string; tipo: string; entitaTipo: string; entitaId: string; debounce?: boolean }> {
    return trigger.notificaEvento.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .filter((p) => p.tipo === 'adesione_promemoria')
        .map((p) => ({
            utenteIds: (p.utenteIds ?? []) as string[],
            corpo: p.corpo as string,
            tipo: p.tipo as string,
            entitaTipo: p.entitaTipo as string,
            entitaId: p.entitaId as string,
            debounce: p.debounce as boolean | undefined,
        }))
}

/** Un avviso di adesione, pronto per la tabella `avvisi`. */
function avvisoAdesione(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: AVVISO,
        titolo: 'Gita al museo',
        contenuto: 'c',
        tipo: 'adesione',
        scuola_id: SEDE_A,
        target_scope: 'globale',
        target_classes: null,
        scadenza_adesione: fraGiorniCivili(2),
        scadenza_avviso: fraGiorniCivili(5),
        form_model_id: null,
        created_at: T0.toISOString(),
        ...patch,
    }
}

function sedeConGiorni(scuolaId: string, giorni: number): Record<string, unknown> {
    return { scuola_id: scuolaId, avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'], promemoria_giorni_prima: giorni } }
}

let seq = 0

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    seq = 0

    db.state.tabelle = {
        admin_settings: [sedeConGiorni(SEDE_A, 3)],
        avvisi: [avvisoAdesione()],
        avvisi_risposte: [],
        notifiche: [],
        armadietto_richieste: [],
        student_documents: [],
    }
    db.state.erroriCoda = {}
    db.state.usate = {}
    db.state.from = []
    db.state.colonneSenzaFiltro = []
    db.state.conteggioDichiarato = {}

    supa.createAdminClient.mockReset().mockImplementation(async () => db.client())
    supa.createClient.mockReset().mockImplementation(async () => db.client())
    vi.stubEnv('CRON_SECRET', SEGRETO)

    destinatari.genitoriDiScuola.mockResolvedValue([P1, P2, P3])
    destinatari.genitoriDiClassi.mockResolvedValue([P1, P2, P3])
    destinatari.staffScuola.mockResolvedValue([])
    armadietto.riconciliaTutto.mockResolvedValue({ alunni: 0, aperte: 0, evase: 0 })

    // `notificaEvento` SCRIVE davvero: è questa riga a rendere la deduplica una
    // proprietà osservabile invece di una promessa.
    trigger.notificaEvento.mockImplementation(async (_s: unknown, p: Record<string, unknown>) => {
        for (const uid of (p.utenteIds ?? []) as string[]) {
            (db.state.tabelle.notifiche ??= []).push({
                id: `n-${++seq}`,
                utente_id: uid,
                tipo: p.tipo,
                entita_id: p.entitaId,
                entita_tipo: p.entitaTipo,
                creato_il: new Date().toISOString(),
            })
        }
    })

    auth.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'admin', scuola_id: SEDE_A }, response: null })
})

afterEach(() => {
    vi.useRealTimers()
})

// ═════════════════════════════════════════════════════════════════════════════
describe('il gate: nessun allarme fabbricabile dall\'esterno', () => {
    it('POST anonimo → 401 e NESSUNA riga error (la route è pubblica e senza rate-limit)', async () => {
        const res = await promemoriaPOST(req())

        expect(res.status).toBe(401)
        // Un bot che bussa 10.000 volte non deve poter scrivere 10.000 righe «il
        // cron è rotto» in `app_log`: sarebbe il segnale vero annegato nel rumore.
        // L'invariante esisteva già per le altre tre scansioni; la quarta non la
        // indebolisce, e questo test è il suo gemello locale.
        expect(erroriCron()).toHaveLength(0)
        expect(trigger.notificaEvento).not.toHaveBeenCalled()
    })

    it('header presente ma sbagliato → 401 e la riga «secret-errato» ci deve essere', async () => {
        const res = await promemoriaPOST(req('chiave-sbagliata'))

        expect(res.status).toBe(401)
        expect(erroriCron()).toEqual([expect.objectContaining({ esito: 'secret-errato' })])
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('chi riceve il promemoria, e chi no', () => {
    it('scadenza fra 2 giorni con promemoria_giorni_prima=3 → parte a chi non ha risposto', async () => {
        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        const inviati = promemoriaInviati()
        expect(inviati).toHaveLength(1)
        expect(inviati[0].utenteIds.sort()).toEqual([P1, P2, P3].sort())
        expect(inviati[0].corpo).toBe('Mancano 2 giorni per aderire a «Gita al museo».')
        // `entitaTipo`/`entitaId` NON sono decorativi: vedi il «ritiro gratuito» in fondo.
        expect(inviati[0].entitaTipo).toBe('avviso')
        expect(inviati[0].entitaId).toBe(AVVISO)
    })

    it('🔑 NIENTE `debounce` — e questo test esiste per vietarlo, non per misurarlo', async () => {
        await promemoriaPOST(req(SEGRETO))

        // Il debounce di `notificaEvento` cancella le notifiche PENDING con lo
        // stesso `tipo + entita_id` e poi riaccoda: serve a far collassare una
        // RAFFICA dentro la finestra di buffer. Qui `bufferMin` vale 0, quindi una
        // riga pending da collassare non esiste mai, e al giro della notte dopo ne
        // nascerebbe comunque una nuova — il debounce guarda la coda, non lo
        // storico. Metterlo SEMBREREBBE una deduplica e non lo sarebbe.
        //
        // ⚠️ E LA DIFFERENZA FRA I DUE TEST VA LETTA INSIEME. Aggiungere
        // `debounce: true` NON fa diventare verde nessun test rosso: i due test
        // della deduplica («due giri, un solo invio» e «scadenza spostata in
        // avanti») restano esattamente come sono, verdi prima e verdi dopo —
        // verificato il 2026-09-19. L'unico a diventare rosso è QUESTO, che non
        // misura un comportamento ma proibisce una scorciatoia: chi un giorno
        // proverà ad «aggiustare» il dedup col debounce si troverà davanti una
        // riga che dice, con il commento accanto, perché non è quella la strada.
        expect(promemoriaInviati()[0].debounce).toBeUndefined()
    })

    it('chi ha risposto «si» O «no» è escluso — sollecitare un «no» è insistere', async () => {
        db.state.tabelle.avvisi_risposte = [
            { avviso_id: AVVISO, parent_id: P1, student_id: 's1', risposta: 'si' },
            { avviso_id: AVVISO, parent_id: P2, student_id: 's2', risposta: 'no' },
            // Presa visione senza risposta: NON è una risposta, il promemoria le spetta.
            { avviso_id: AVVISO, parent_id: P3, student_id: 's3', risposta: null },
        ]

        await promemoriaPOST(req(SEGRETO))

        const inviati = promemoriaInviati()
        expect(inviati).toHaveLength(1)
        expect(inviati[0].utenteIds).toEqual([P3])
    })

    it('avviso già scaduto → zero promemoria (si aderisce fino all\'istante, non dopo)', async () => {
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(-1) })]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        expect(promemoriaInviati()).toHaveLength(0)
        expect(battito('ok')).toMatchObject({ adesioni: 0 })
    })

    it('promemoria_giorni_prima=0 → nessun invio, e il battito resta «ok» con il contatore a 0', async () => {
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 0)]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        expect(promemoriaInviati()).toHaveLength(0)
        // «Zero» perché la sede l'ha spento è comunque «ho guardato»: il giro è
        // `ok`, non `ok-parziale`. Il terzo stato è per chi NON ha potuto guardare.
        expect(battito('ok')).toMatchObject({ adesioni: 0 })
        expect(righe().some((r) => r.campi.esito === 'ok-parziale')).toBe(false)
    })

    it('il corpo ha i tre rami: «Mancano N», «Manca 1», «Ultimo giorno»', async () => {
        for (const [giorni, atteso] of [
            [2, 'Mancano 2 giorni per aderire a «Gita al museo».'],
            [1, 'Manca 1 giorno per aderire a «Gita al museo».'],
            [0, 'Ultimo giorno per aderire a «Gita al museo».'],
        ] as Array<[number, string]>) {
            vi.clearAllMocks()
            trigger.notificaEvento.mockResolvedValue(undefined)
            db.state.tabelle.notifiche = []
            db.state.usate = {}
            db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(giorni) })]

            await promemoriaPOST(req(SEGRETO))

            expect(promemoriaInviati()[0]?.corpo, `giorni=${giorni}`).toBe(atteso)
        }
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('un solo invio per famiglia — e la deduplica è UNA query, non il debounce', () => {
    it('🔑 due giri consecutivi → UN solo enqueue (il secondo legge ciò che il primo ha scritto)', async () => {
        await promemoriaPOST(req(SEGRETO))
        expect(promemoriaInviati()).toHaveLength(1)

        // Il giro della notte dopo, con la scadenza ancora davanti.
        vi.setSystemTime(new Date(T0.getTime() + 86_400_000))
        db.state.usate = {}
        await promemoriaPOST(req(SEGRETO))

        // Se questa asserzione diventa 2, la deduplica non c'è: la prova di
        // rottura n. 1 della testata è esattamente questa.
        expect(promemoriaInviati()).toHaveLength(1)
        expect(db.state.tabelle.notifiche).toHaveLength(3) // una per famiglia, una volta sola
    })

    /**
     * 🔴 IL MARGINE DELLA FINESTRA DI DEDUP, E PERCHÉ DUE TEST E NON UNO.
     *
     * La finestra di deduplica si misura all'indietro da `adesso`. Scritta larga
     * ESATTAMENTE `giorni` giorni, dura quanto l'intervallo fra un giro e il
     * successivo: margine zero, e il margine reale in produzione è solo il δ fra
     * il `new Date()` della quarta scansione e l'`INSERT` (`notifiche.creato_il`
     * è `DEFAULT now()`) — mentre `adessoISO` viene preso DOPO le altre tre
     * scansioni, la cui durata varia di secondi ogni notte. Un millisecondo di
     * ritardo in più del giro precedente e il sollecito riparte: una moneta
     * lanciata su ogni avviso, all'ultimo giro — quello che dice «Ultimo giorno
     * per aderire».
     *
     * Misurato sul codice PRIMA della correzione, non dedotto:
     *   giorni=1, due giri a 24h + 30 s  → 2 notifiche          (doppione)
     *   giorni=3, quattro giri, +1 ms    → esiti [1,0,0,1]      (doppione)
     *   giorni=3, quattro giri, ritardo 0 → esiti [1,0,0,0]     (controllo positivo)
     *
     * I due test qui sotto sono quei due scenari. Il ritardo NON è cosmetico: con
     * ritardo zero entrambi restano verdi anche sul codice rotto, ed è il motivo
     * per cui il difetto è sopravvissuto alla prima stesura dei test.
     *
     * 🔑 Il finto scrive `creato_il` con l'istante del giro (`new Date()` sotto
     * fake timers): senza quello il test misurerebbe sé stesso.
     */
    it('🔑 giorni=1, due giri a 24h + 30 SECONDI → UN solo invio (il margine della finestra)', async () => {
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 1)]
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(1) })]

        await promemoriaPOST(req(SEGRETO))
        expect(promemoriaInviati()).toHaveLength(1)

        // Il giro della notte dopo, partito TRENTA SECONDI più tardi: le tre
        // scansioni che vengono prima hanno impiegato un po' di più, e `adessoISO`
        // si prende dopo di loro. Con la finestra larga esattamente `giorni`, il
        // promemoria di ieri cade fuori per trenta secondi.
        vi.setSystemTime(new Date(T0.getTime() + 86_400_000 + 30_000))
        db.state.usate = {}
        await promemoriaPOST(req(SEGRETO))

        expect(promemoriaInviati()).toHaveLength(1)
        expect(db.state.tabelle.notifiche).toHaveLength(3) // una per famiglia, una volta sola
    })

    it('🔑 giorni=3, quattro giri con ritardi crescenti (+0, +10s, +20s, +30s) → esiti [1,0,0,0]', async () => {
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 3)]
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(3) })]

        const esiti: number[] = []
        for (let giro = 0; giro < 4; giro++) {
            vi.setSystemTime(new Date(T0.getTime() + giro * 86_400_000 + giro * 10_000))
            db.state.usate = {}
            const prima = promemoriaInviati().length
            await promemoriaPOST(req(SEGRETO))
            esiti.push(promemoriaInviati().length - prima)
        }

        // Il quarto giro è quello dell'«Ultimo giorno per aderire»: è lì che il
        // doppione cadeva, perché è lì che il primo promemoria compie `giorni`.
        expect(esiti).toEqual([1, 0, 0, 0])
        expect(db.state.tabelle.notifiche).toHaveLength(3)
    })

    /**
     * 🔴 IL `+1` DELLA FINESTRA, CHE FINO AD OGGI NON ERA PINNATO DA NESSUNO.
     *
     * La deduplica guarda indietro di `giorni + 1` GIORNI CIVILI. Il `+1` è un
     * margine, e i due `it` qui sopra — «24h + 30 s» e «quattro giri con ritardi
     * crescenti» — sono stati scritti per difenderlo. Non lo difendono più, e va
     * detto invece di lasciarlo credere: **misurato togliendo il `+1`, restano
     * entrambi VERDI**. Difendono il CALENDARIO (che il cutoff si misuri in giorni
     * civili e non in `× 86.400.000`), non il MARGINE — da quando il cutoff passa
     * da `inizioGiornoCivile`, trenta secondi di ritardo non spostano più niente,
     * che è esattamente ciò che quella correzione voleva ottenere.
     *
     * Il `+1` si vede in un punto solo: il BORDO della finestra, cioè quando fra il
     * sollecito precedente e oggi sono passati ESATTAMENTE `giorni + 1` giorni
     * civili. Ci si arriva col gesto vero della segreteria — una scadenza rinviata
     * di qualche giorno, che riporta l'avviso in finestra prima che il vecchio
     * sollecito sia uscito dalla deduplica.
     *
     * ⚠️ E IL VERSO OPPOSTO HA GIÀ IL SUO TEST: «scadenza SPOSTATA IN AVANTI» qui
     * sotto sposta di OTTO giorni con `giorni = 3`, cioè ben oltre `giorni + 1 = 4`,
     * e pretende che il sollecito RIPARTA. I due si guardano le spalle: questo
     * vieta di stringere la finestra, quello vieta di allargarla. Chi tocca il
     * margine deve farli passare entrambi.
     *
     * Prova di rottura ESEGUITA (2026-09-19): `giorni + 1` → `giorni` (in tutte e
     * due le occorrenze, il giorno civile e il ripiego in millisecondi) → questo
     * `it` ROSSO (due invii invece di uno); `giorni + 1` → `giorni + 8` → il test
     * «scadenza SPOSTATA IN AVANTI» ROSSO. Ripristinati → verdi.
     */
    it('🔴 il MARGINE: il sollecito di `giorni + 1` giorni civili fa è ANCORA dentro la finestra', async () => {
        // `giorni = 1` rende il bordo raggiungibile in due giorni invece di quattro:
        // la proprietà è la stessa, il test costa la metà.
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 1)]
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(1) })]

        await promemoriaPOST(req(SEGRETO))
        expect(promemoriaInviati()).toHaveLength(1)

        // La segreteria sposta la gita di due giorni: l'avviso torna in finestra al
        // giro di dopodomani (mancherà di nuovo 1 giorno).
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(3) })]

        // Due giorni civili dopo: il sollecito di allora compie ESATTAMENTE
        // `giorni + 1` giorni. Con il margine è ancora dentro e non si ripete; con
        // la finestra larga `giorni` secchi è appena uscito, e la stessa famiglia
        // riceve un secondo messaggio sullo stesso avviso.
        vi.setSystemTime(new Date(T0.getTime() + 2 * 86_400_000))
        db.state.usate = {}
        await promemoriaPOST(req(SEGRETO))

        expect(promemoriaInviati()).toHaveLength(1)
        expect(db.state.tabelle.notifiche).toHaveLength(3) // una per famiglia, una volta sola
    })

    it('scadenza SPOSTATA IN AVANTI oltre la finestra → il sollecito riparte (è il `.gte(creato_il)`)', async () => {
        // Primo giro: mancano 3 giorni, la sede ne vuole 3 → parte.
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 3)]
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(3) })]
        await promemoriaPOST(req(SEGRETO))
        expect(promemoriaInviati()).toHaveLength(1)

        // La segreteria rinvia la gita: nuova scadenza fra 10 giorni dall'inizio.
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(10) })]

        // Otto giorni dopo mancano 2 giorni: si rientra in finestra, e il
        // promemoria di otto giorni fa è FUORI dai 3 giorni di deduplica. Deve
        // ripartire — altrimenti una scadenza spostata non avvisa più nessuno.
        vi.setSystemTime(new Date(T0.getTime() + 8 * 86_400_000))
        db.state.usate = {}
        await promemoriaPOST(req(SEGRETO))

        expect(promemoriaInviati()).toHaveLength(2)
        expect(promemoriaInviati()[1].corpo).toBe('Mancano 2 giorni per aderire a «Gita al museo».')
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la soglia è quella della SUA sede, non il massimo del giro', () => {
    it('🔑 due sedi con N diverso (3 e 7): riceve solo quella da 7', async () => {
        const AVVISO_B = '22222222-2222-2222-2222-222222222222'
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 3), sedeConGiorni(SEDE_B, 7)]
        db.state.tabelle.avvisi = [
            avvisoAdesione({ id: AVVISO, scuola_id: SEDE_A, scadenza_adesione: fraGiorniCivili(5) }),
            avvisoAdesione({ id: AVVISO_B, scuola_id: SEDE_B, titolo: 'Recita', scadenza_adesione: fraGiorniCivili(5) }),
        ]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        const inviati = promemoriaInviati()
        // `nMax` vale 7 e porta a casa ENTRAMBI gli avvisi: è un filtro grossolano.
        // La soglia vera è per sede, e a 5 giorni dalla scadenza solo la sede da 7
        // sollecita. Usare `nMax` come soglia fa passare anche la sede da 3: è la
        // prova di rottura n. 2 della testata.
        expect(inviati).toHaveLength(1)
        expect(inviati[0].entitaId).toBe(AVVISO_B)
    })

    it('🔑 il confine ALTO è la FINE del giorno civile: scadenza alle 18:00 del giorno `oggi + nMax` → ENTRA', async () => {
        // ⚠️ QUESTO `it` ESISTE PERCHÉ DUE DIFETTI NON POSSONO DIVIDERSI UN'ASSERZIONE.
        // Il confine alto del filtro grossolano era pinnato soltanto dal test
        // «scadenza SPOSTATA IN AVANTI» — che è lo STESSO test che pinna il cutoff
        // della deduplica. Chi un giorno «aggiusterà» quel test si porterebbe via
        // entrambe le difese senza accorgersene.
        //
        // Il difetto vero: la prima stesura scriveva `new Date(adesso + nMax *
        // 86_400_000)`. Il giro parte di mattina, una scadenza «fra 3 giorni
        // civili» sta alle 18:00 del terzo giorno, e 3 × 24 ore da stamattina
        // finiscono stamattina — ore PRIMA. Il filtro di comodo tagliava fuori
        // esattamente gli avvisi che la soglia voleva dentro, in silenzio:
        // contatore a zero, battito «ok».
        db.state.tabelle.admin_settings = [sedeConGiorni(SEDE_A, 3)]
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: fraGiorniCivili(3) })]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        const inviati = promemoriaInviati()
        expect(inviati).toHaveLength(1)
        expect(inviati[0].corpo).toBe('Mancano 3 giorni per aderire a «Gita al museo».')
        expect(battito('ok')).toMatchObject({ adesioni: 3 })
    })

    /**
     * 🔴 IL QUARTO POSTO DEL GEMELLO, E L'UNICO CHE NON AVEVA UN TEST.
     *
     * La regola è arbitrata in `@/lib/avvisi/scadenze` — «LA SCADENZA È L'ULTIMO
     * ISTANTE VALIDO, INCLUSO» — e quel riquadro elenca i quattro posti che devono
     * usare lo stesso operatore:
     *
     *   1. `avvisoScaduto()` ..................... `adesso >  scadenza`
     *   2. la RPC `avviso_adesione_registra` ..... `v_ora  >  v_termine`
     *   3. il filtro del feed .................... `.gte(…)`, **mai** `.gt`
     *   4. il filtro di QUESTA scansione ......... `.gte(…)`
     *
     * I primi tre avevano un test (`__tests__/api/avvisi-feed-scadenza-istante.test.ts`
     * per il terzo, ed è lo stampo di questo). Il quarto no — ed era proprio quello
     * che era stato scritto `.gt`, cioè con l'operatore proibito, giustificato da un
     * commento che dichiarava una divergenza già chiusa. Senza questo `it` la riga
     * può tornare `.gt` domani senza che niente diventi rosso: l'effetto pratico è un
     * millisecondo, e un millisecondo non si nota — si nota solo che i quattro posti
     * hanno smesso di dire la stessa cosa.
     *
     * Prova di rottura ESEGUITA (2026-09-19): `.gte('scadenza_adesione', adessoISO)`
     * → `.gt(…)` in `src/lib/avvisi/promemoria-adesioni.ts` → questo `it` diventa
     * ROSSO (zero invii invece di uno) e NESSUN altro test della suite cambia colore.
     */
    it('🔑 CONFINE: la scadenza nell’ISTANTE ESATTO del giro entra ancora (`.gte`, mai `.gt`)', async () => {
        const ALTRO = '22222222-2222-2222-2222-222222222229'
        db.state.tabelle.avvisi = [
            // L'istante esatto della scansione: è l'unico caso che distingue `.gte`
            // da `.gt`. La RPC dell'adesione accetterebbe ancora una risposta in
            // questo millisecondo, quindi il sollecito è dovuto.
            avvisoAdesione({ id: AVVISO, scadenza_adesione: T0.toISOString() }),
            // Un millisecondo PRIMA: fuori con entrambi gli operatori. È il controllo
            // positivo all'incontrario — senza, l'asserzione qui sotto sarebbe verde
            // anche con NESSUN filtro, perché «tutto entra» e «l'estremo entra» hanno
            // lo stesso colore.
            avvisoAdesione({ id: ALTRO, titolo: 'Recita', scadenza_adesione: '2026-09-21T06:59:59.999Z' }),
        ]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        const inviati = promemoriaInviati()
        expect(inviati).toHaveLength(1)
        expect(inviati[0].entitaId).toBe(AVVISO)
        // Zero giorni civili di distanza: è l'ultimo giro utile, e il corpo lo dice.
        expect(inviati[0].corpo).toBe('Ultimo giorno per aderire a «Gita al museo».')
    })

    it('una sede SENZA riga in admin_settings usa il default, non «spento»', async () => {
        // Aversa e Cesa sono nate con `avvisi_config = {}`: una sede che non ha
        // ancora salvato le impostazioni non deve perdere i promemoria.
        db.state.tabelle.admin_settings = []

        await promemoriaPOST(req(SEGRETO))

        expect(promemoriaInviati()).toHaveLength(1)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('il battito non può mentire', () => {
    it('giro sano → «ok» e il contatore `adesioni` C\'È (senza, «zero» non si distingue da «non ho guardato»)', async () => {
        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        const ok = battito('ok')
        expect(ok).toBeDefined()
        expect(ok).toMatchObject({ moduli: 0, armadietto: 0, documenti: 0, adesioni: 3 })
        expect(erroriCron()).toHaveLength(0)
    })

    it('colonna assente (DB E2E non migrato) → 200, «ok-parziale», e `adesioni` NOMINATO', async () => {
        // La prima lettura di `avvisi` è della scansione dei moduli e va bene; la
        // seconda è la nostra, e su un ambiente senza la migrazione A2 torna 42703.
        db.state.erroriCoda.avvisi = [null, COLONNA_ASSENTE]

        const res = await promemoriaPOST(req(SEGRETO))

        // Non è un guasto: la CI E2E gira su un progetto separato e mai migrato.
        expect(res.status).toBe(200)
        expect(erroriCron()).toHaveLength(0)
        // Ma non è nemmeno «ok»: chi sorveglia i cron cerca `esito: 'ok'`.
        expect(battito('ok')).toBeUndefined()
        const parziale = battito('ok-parziale')
        expect(parziale).toBeDefined()
        // L'asserzione è sul NOME, non sullo status: un 200 lo darebbe anche un
        // giro che ha guardato tutto, e «manca qualcosa senza dire cosa» costringe
        // a indovinare quale delle quattro.
        expect(parziale?.azione).toBe('adesioni')
        // 🔑 E IL CONTATORE C'È ANCHE QUI. Era pinnato solo sul ramo `ok`: togliere
        // `adesioni: esiti.adesioni` da questo battito e da `giro-incompleto`
        // lasciava la suite INTERA verde (misurato). È proprio il battito che non
        // deve poter mentire — «ok-parziale» senza il numero non distingue «la
        // quarta scansione non ha guardato» da «ha guardato e non c'era nulla», che
        // è la stessa ambiguità per cui il terzo stato esiste.
        expect(parziale).toHaveProperty('adesioni', 0)
        expect(promemoriaInviati()).toHaveLength(0)
    })

    it('la lettura di `notifiche` fallita → 500 «giro-incompleto», e nessun promemoria spedito alla cieca', async () => {
        db.state.erroriCoda.notifiche = [DB_IN_AFFANNO]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(500)
        expect(battito('ok')).toBeUndefined()
        expect(battito('ok-parziale')).toBeUndefined()
        expect(erroriCron()).toEqual([
            expect.objectContaining({ esito: 'scansione-fallita', azione: 'adesioni' }),
            expect.objectContaining({ esito: 'giro-incompleto', azione: 'adesioni' }),
        ])
        // Il gemello dell'asserzione su `ok-parziale`: anche il battito del giro
        // caduto porta il contatore, e per la ragione opposta — un `giro-incompleto`
        // senza `adesioni` non direbbe se la scansione è morta PRIMA o DOPO aver
        // accodato qualcosa.
        expect(battito('giro-incompleto')).toHaveProperty('adesioni', 0)
        // La deduplica È quella query: fallita e ignorata, lo stesso sollecito
        // ripartirebbe ogni notte per sempre. Si preferisce non mandare niente.
        expect(promemoriaInviati()).toHaveLength(0)
    })

    it('🔑 pagina VUOTA con il `count` ancora più alto → la scansione LANCIA (500), e non sollecita nessuno', async () => {
        // LA LETTURA DI «CHI HA GIÀ RISPOSTO» NON SI PUÒ TRONCARE, e questo è il
        // test che lo rende una proprietà invece di un commento. Una pagina persa
        // qui non produce un numero più basso: produce un SOLLECITO SPEDITO A CHI
        // HA GIÀ ADERITO — un dato falso mandato a una famiglia. Perciò
        // `parentIdsCheHannoRisposto` LANCIA invece di degradare, e fino ad oggi
        // quel `throw` non era mai stato visto rosso: nessun test esercitava né la
        // seconda pagina né la pagina vuota.
        //
        // Lo scenario è quello vero di PostgREST: `count: 'exact'` dice 5, la
        // pagina ne rende 0. Continuare girerebbe a vuoto, e l'insieme che si
        // porta a casa sarebbe incompleto.
        db.state.tabelle.avvisi_risposte = []
        db.state.conteggioDichiarato = { avvisi_risposte: 5 }

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(500)
        // Meglio un giro che si dichiara caduto che uno che manda messaggi
        // sbagliati dichiarando «ok».
        expect(promemoriaInviati()).toHaveLength(0)
        expect(battito('ok')).toBeUndefined()
        expect(battito('ok-parziale')).toBeUndefined()
        expect(erroriCron()).toEqual([
            expect.objectContaining({ esito: 'scansione-fallita', azione: 'adesioni' }),
            expect.objectContaining({ esito: 'giro-incompleto', azione: 'adesioni' }),
        ])
    })

    it('avviso di adesione SENZA scadenza_adesione → saltato, e detto con un `warn` contato', async () => {
        // Il ramo in memoria è il gemello dei filtri server sulla scadenza: per
        // raggiungerlo si simula l'ambiente in cui quei filtri non ci sono.
        db.state.colonneSenzaFiltro = ['scadenza_adesione']
        db.state.tabelle.avvisi = [avvisoAdesione({ scadenza_adesione: null })]

        const res = await promemoriaPOST(req(SEGRETO))

        expect(res.status).toBe(200)
        expect(promemoriaInviati()).toHaveLength(0)
        const avvisi = righe('warn').filter((r) => r.evento === 'avvisi')
        expect(avvisi).toHaveLength(1)
        expect(avvisi[0].campi).toMatchObject({ esito: 'adesione-senza-scadenza', n: 1 })
        // Solo un conteggio: nessun titolo, nessun uuid di famiglia (regola 8).
        expect(Object.keys(avvisi[0].campi).sort()).toEqual(['esito', 'n', 'operazione'])
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('il ritiro gratuito: cancellare l\'avviso toglie anche il promemoria', () => {
    it('DELETE /api/avvisi/[id] rimuove la notifica scritta dal cron (entita_tipo = «avviso»)', async () => {
        await promemoriaPOST(req(SEGRETO))
        expect(db.state.tabelle.notifiche).toHaveLength(3)

        // La notifica di un'ALTRA entità con lo stesso uuid: il controllo positivo
        // dell'asserzione negativa. Se il filtro `entita_tipo` sparisse, questa
        // sparirebbe con le altre.
        db.state.tabelle.notifiche.push({
            id: 'n-altro', utente_id: P1, tipo: 'galleria',
            entita_id: AVVISO, entita_tipo: 'media', creato_il: T0.toISOString(),
        })

        const res = await avvisoDELETE(
            new Request(`http://localhost/api/avvisi/${AVVISO}`, { method: 'DELETE' }),
            { params: Promise.resolve({ id: AVVISO }) },
        )

        expect(res.status).toBe(200)
        // `entitaTipo: 'avviso'` sul promemoria non è un'etichetta: è ciò che lo
        // fa ritirare dalla campanella insieme all'avviso, senza una riga di
        // codice in più nel cron. Verificato, non dato per scontato.
        expect(db.state.tabelle.notifiche.map((n) => n.id)).toEqual(['n-altro'])
    })
})
