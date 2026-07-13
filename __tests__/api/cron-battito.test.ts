import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * IL BATTITO DEI CRON NON PUÒ MENTIRE.
 *
 * I cinque job dichiarano «sono partito» e «ho finito» proprio perché pg_net li invoca in
 * fire-and-forget dentro un `EXCEPTION WHEN OTHERS THEN null`: un job che non parte non lascia
 * traccia, e l'unico modo di sorvegliarlo è sorvegliare l'ASSENZA del suo battito.
 *
 * Da cui i due modi di rovinare tutto, che sono i due difetti che questi test bloccano:
 *
 *  1. UN BATTITO CHE MENTE. PostgREST non lancia: ritorna `{ error }` (regola 7 di AGENTS.md).
 *     Una query fallita e non controllata lascia `data` a `null`, il codice scivola nel ramo
 *     «zero elementi» e il battito scrive `esito: 'ok'`. Chi sorveglia vede verde ogni notte
 *     mentre nessuna push parte più — lo STESSO guasto muto delle email di credenziali,
 *     ricreato dal codice che doveva prevenirlo. Senza battito il bug era latente; con un
 *     battito che non guarda `error` è ATTIVAMENTE coperto.
 *
 *  2. UN ALLARME CHE CHIUNQUE PUÒ FABBRICARE. Queste route sono pubbliche e senza rate-limit:
 *     se il ramo del secret gridasse anche sul POST anonimo, un `curl` — o un bot che bussa
 *     10.000 volte — scriverebbe righe `error` in `app_log` e produrrebbe dal nulla il segnale
 *     «il cron è rotto», cioè esattamente il segnale che quella riga esiste per portare. Si
 *     grida SOLO se l'header c'è ma non corrisponde (un cron con la chiave sbagliata: il guasto
 *     invisibile), e si tace sul POST anonimo.
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (`.env.local` punta al DB di
 * PRODUZIONE: una suite che scrive righe di log in produzione è un incidente, non un test), e
 * un logger muto non si può ispezionare. Lo si mocka quindi con delle spie e si asserisce sulle
 * CHIAMATE: `logEvento('cron', 'error', …)` è la riga che finirebbe in tabella — e che finisca
 * davvero in tabella lo prova `vaPersistito`, quello VERO, nell'ultimo test.
 */

// ── Le spie sul logger ───────────────────────────────────────────────────────
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

// ── Il finto Supabase: builder thenable, code PostgREST realistici ───────────
//
// Ogni tabella ha una CODA FIFO di risposte `{ data, error }`, consumata nell'ordine in cui la
// route la interroga. È l'unico modo di dire «la prima lettura va, la seconda no» — che è
// precisamente lo scenario dei difetti (`notifiche` ok, `push_subscriptions` giù).
const db = vi.hoisted(() => {
    const state = {
        code: {} as Record<string, Array<{ data?: unknown; error?: unknown }>>,
        usate: {} as Record<string, number>,
        calls: [] as Array<{ table: string; m: string }>,
    }
    function prendi(table: string): { data: unknown; error: unknown } {
        const coda = state.code[table] ?? []
        const i = state.usate[table] ?? 0
        state.usate[table] = i + 1
        const r = coda[i] ?? {}
        return { data: r.data ?? null, error: r.error ?? null }
    }
    function client() {
        return {
            from(table: string) {
                const qb: Record<string, unknown> = {}
                // Ogni metodo di catena registra la chiamata e restituisce il builder: è così che
                // si può asserire «l'UPDATE su `notifiche` NON è mai partito», che è il cuore del
                // difetto distruttivo. Gli argomenti si ignorano di proposito (qui interessa SE
                // una scrittura è avvenuta, non con quali valori).
                const rec = (m: string) => () => {
                    state.calls.push({ table, m })
                    return qb
                }
                for (const m of [
                    'select', 'is', 'or', 'order', 'limit', 'in', 'update', 'delete',
                    'eq', 'neq', 'not', 'lt', 'lte', 'gte',
                ]) qb[m] = rec(m)
                qb.maybeSingle = async () => prendi(table)
                qb.single = async () => prendi(table)
                qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                    Promise.resolve(prendi(table)).then(res, rej)
                return qb
            },
            storage: { from: () => ({ upload: async () => ({}) }) },
        }
    }
    return { state, client }
})

// Le spie sono ESPOSTE (e non chiuse dentro la factory) perché serve poterle far LANCIARE:
// `createAdminClient()` è il primo pezzo di mondo esterno che ogni cron tocca, ed è il punto in
// cui una `SUPABASE_SERVICE_ROLE_KEY` assente o ruotata male fa morire il giro intero. Vedi il
// DIFETTO 3.
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

// ── Le dipendenze non-DB delle cinque route ─────────────────────────────────
const push = vi.hoisted(() => ({ sendPush: vi.fn(), vapidConfigured: vi.fn(() => true) }))
vi.mock('@/lib/push/web-push', () => push)
const native = vi.hoisted(() => ({ sendNativePush: vi.fn(), fcmConfigured: vi.fn(() => false) }))
vi.mock('@/lib/push/native-push', () => native)
const enqueue = vi.hoisted(() => ({ enqueueNotifiche: vi.fn() }))
vi.mock('@/lib/push/enqueue', () => enqueue)

const auth = vi.hoisted(() => ({ requireStaff: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)
const mensa = vi.hoisted(() => ({ loadResolveOptions: vi.fn(async () => ({})), DEFAULT_SCUOLA: 'kidville' }))
vi.mock('@/lib/mensa/server', () => mensa)
const allergie = vi.hoisted(() => ({ controllaAllergie: vi.fn(async () => false) }))
vi.mock('@/lib/mensa/allergie-check', () => allergie)

const solleciti = vi.hoisted(() => ({ sollecitaPagamenti: vi.fn(async () => []) }))
vi.mock('@/lib/pagamenti/solleciti-invio', () => solleciti)

const aruba = vi.hoisted(() => ({
    arubaSignin: vi.fn(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })),
    arubaGetByFilename: vi.fn(async () => ({ stato: 7 })),
    resolveArubaCredentials: vi.fn(() => ({ username: 'u', password: 'p' })),
}))
vi.mock('@/lib/aruba/client', () => aruba)

const notifiche = vi.hoisted(() => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => notifiche)
const destinatari = vi.hoisted(() => ({
    genitoriDiAlunni: vi.fn(async () => [] as string[]),
    genitoriDiClassi: vi.fn(async () => [] as string[]),
    genitoriDiScuola: vi.fn(async () => [] as string[]),
    staffScuola: vi.fn(async () => [] as string[]),
}))
vi.mock('@/lib/notifiche/destinatari', () => destinatari)
const settings = vi.hoisted(() => ({ getModuleConfig: vi.fn(async () => ({})) }))
vi.mock('@/lib/settings/module-config', () => settings)

import { POST as dispatchPOST } from '@/app/api/push/dispatch/route'
import { POST as promemoriaPOST } from '@/app/api/notifiche/promemoria/route'
import { POST as allergiePOST } from '@/app/api/mensa/allergie-check/route'
import { POST as sollecitiPOST } from '@/app/api/pagamenti/solleciti/run/route'
import { POST as fatturaPOST } from '@/app/api/pagamenti/fattura/sync/route'

const SEGRETO = 'test-secret'
const SCUOLA = '11111111-1111-1111-1111-111111111111'

/**
 * Un DB IN AFFANNO, non un DB assente. È il punto: `57014` è ciò che risponde Postgres quando
 * una query supera lo `statement_timeout` — un guasto TRANSITORIO e realistico (RLS cambiata,
 * 503, tabella sotto carico). Non è «tabella mancante», e non deve essere trattato come tale:
 * il codice non può assorbirlo come fa con lo schema drift del DB E2E.
 */
const DB_IN_AFFANNO = {
    code: '57014',
    message: 'canceling statement due to statement timeout',
    details: null,
    hint: null,
}

/** Ambiente non migrato (il DB E2E della CI): questo sì che va assorbito in silenzio. */
const TABELLA_ASSENTE = { code: '42P01', message: 'relation "avvisi" does not exist' }

function req(url: string, secret?: string): Request {
    return new Request(url, { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {} })
}

/** Le righe che il job ha emesso, per livello. `campi` è il 3° argomento di `logEvento`. */
function righe(livello?: string): Array<{ evento: string; campi: Record<string, unknown>; err: unknown }> {
    return log.logEvento.mock.calls
        .filter((c) => livello === undefined || c[1] === livello)
        .map((c) => ({ evento: c[0] as string, campi: (c[2] ?? {}) as Record<string, unknown>, err: c[3] }))
}

/** Il battito di chiusura: `esito: 'ok'`. È QUESTO che chi sorveglia i cron cerca. */
function battitoOk(): boolean {
    return righe().some((r) => r.evento === 'cron' && r.campi.esito === 'ok')
}

/** Le righe che `vaPersistito` manderebbe in `app_log` come guasto (livello `error`). */
function errori(): Array<Record<string, unknown>> {
    return righe('error').filter((r) => r.evento === 'cron').map((r) => r.campi)
}

function chiamate(table: string, m: string): number {
    return db.state.calls.filter((c) => c.table === table && c.m === m).length
}

/** I cinque cron. Stessa forma, stesse invarianti: i lock qui sotto girano su tutti e cinque. */
const CRON: Array<[string, (r: Request) => Promise<Response>, string]> = [
    ['push/dispatch', dispatchPOST, 'http://localhost/api/push/dispatch'],
    ['notifiche/promemoria', promemoriaPOST, 'http://localhost/api/notifiche/promemoria'],
    ['mensa/allergie-check', allergiePOST, 'http://localhost/api/mensa/allergie-check'],
    ['pagamenti/solleciti/run', sollecitiPOST, 'http://localhost/api/pagamenti/solleciti/run'],
    ['pagamenti/fattura/sync', fatturaPOST, 'http://localhost/api/pagamenti/fattura/sync'],
]

beforeEach(() => {
    vi.clearAllMocks()
    db.state.code = {}
    db.state.usate = {}
    db.state.calls = []
    // `mockReset` e non solo `clearAllMocks`: quest'ultimo azzera le CHIAMATE, non le
    // implementazioni «once» — un `mockRejectedValueOnce` non consumato traboccherebbe nel test
    // successivo, e un client che lancia a sorpresa è il modo più efficace di rendere una suite
    // illeggibile.
    supa.createAdminClient.mockReset().mockImplementation(async () => db.client())
    supa.createClient.mockReset().mockImplementation(async () => db.client())
    vi.stubEnv('CRON_SECRET', SEGRETO)
    push.vapidConfigured.mockReturnValue(true)
    native.fcmConfigured.mockReturnValue(false)
    push.sendPush.mockResolvedValue({ ok: true })
    aruba.resolveArubaCredentials.mockReturnValue({ username: 'u', password: 'p' })
    aruba.arubaSignin.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    aruba.arubaGetByFilename.mockResolvedValue({ stato: 7 })
    solleciti.sollecitaPagamenti.mockResolvedValue([])
    allergie.controllaAllergie.mockResolvedValue(false)
    auth.requireStaff.mockResolvedValue({
        response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('DIFETTO 1 — una query fallita NON chiude il giro con «ok»', () => {
    it('push/dispatch: lettura notifiche fallita → 500, riga d\'errore col corpo di PostgREST, nessun «ok»', async () => {
        db.state.code = { notifiche: [{ error: DB_IN_AFFANNO }] }

        const res = await dispatchPOST(req('http://localhost/api/push/dispatch', SEGRETO))

        expect(res.status).toBe(500)
        // Il difetto in una riga: prima di questo fix la route rispondeva 200 e il battito
        // diceva «ok, inviate: 0» — indistinguibile dalla notte in cui non c'è nulla da inviare.
        expect(battitoOk()).toBe(false)
        const e = errori()
        expect(e).toHaveLength(1)
        expect(e[0]).toMatchObject({ operazione: 'push-dispatch', esito: 'query-fallita', azione: 'lettura notifiche' })
        // Il corpo dell'errore del provider NON si butta via (regola 3): l'oggetto PostgREST —
        // con `code` e `message` — viaggia nel 4° argomento, o la riga direbbe che qualcosa è
        // fallito senza dire perché.
        expect(righe('error')[0].err).toBe(DB_IN_AFFANNO)
    })

    it('push/dispatch: lettura push_subscriptions fallita → nessuna push, e soprattutto NESSUNA marcatura', async () => {
        // Il caso distruttivo: `subsByUser` resta vuota, ma prima del fix `inviateIds` si
        // riempiva lo stesso e le notifiche venivano marcate `push_inviata_il` — cioè PERSE PER
        // SEMPRE, con il log che diceva «ok».
        db.state.code = {
            notifiche: [{ data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }] }],
            push_subscriptions: [{ error: DB_IN_AFFANNO }],
        }

        const res = await dispatchPOST(req('http://localhost/api/push/dispatch', SEGRETO))

        expect(res.status).toBe(500)
        expect(battitoOk()).toBe(false)
        expect(push.sendPush).not.toHaveBeenCalled()
        // LA RIGA CHE CONTA: nessun UPDATE su `notifiche`. Le notifiche restano in coda e
        // partiranno al giro successivo, quando il DB avrà smesso di affannarsi.
        expect(chiamate('notifiche', 'update')).toBe(0)
        expect(errori()[0]).toMatchObject({ esito: 'query-fallita', azione: 'lettura push_subscriptions' })
    })

    it('mensa/allergie-check: lettura alunni fallita → 500, nessun controllo allergie spacciato per «ok»', async () => {
        // È la tabella che porta le ALLERGIE. Ignorare `error` qui significa `rows` vuoto: zero
        // conflitti, zero alert, battito «ok» — e un bambino allergico che non riceve l'alert.
        db.state.code = {
            mensa_prenotazioni: [{ data: [{ alunno_id: 'a1' }] }],
            alunni: [{ error: DB_IN_AFFANNO }],
        }

        const res = await allergiePOST(req('http://localhost/api/mensa/allergie-check', SEGRETO))

        expect(res.status).toBe(500)
        expect(battitoOk()).toBe(false)
        expect(allergie.controllaAllergie).not.toHaveBeenCalled()
        expect(errori()[0]).toMatchObject({ esito: 'query-fallita', azione: 'lettura alunni', canale: 'cron' })
    })

    it('pagamenti/solleciti/run: lettura candidati fallita → 500, nessun sollecito, nessun «ok»', async () => {
        db.state.code = {
            // 1ª: l'UPDATE degli stati scaduti. 2ª: la SELECT dei candidati — quella che cade.
            pagamenti: [{ data: null }, { error: DB_IN_AFFANNO }],
            admin_settings: [{ data: [{ scuola_id: SCUOLA, solleciti_config: { enabled: true } }] }],
        }

        const res = await sollecitiPOST(req('http://localhost/api/pagamenti/solleciti/run', SEGRETO))

        expect(res.status).toBe(500)
        // Prima del fix: 200 con «ok, esaminati: 0» — cioè «nessun moroso», la notizia più bella
        // e più falsa che un log possa dare a una segreteria.
        expect(battitoOk()).toBe(false)
        expect(solleciti.sollecitaPagamenti).not.toHaveBeenCalled()
        expect(errori()[0]).toMatchObject({ esito: 'query-fallita', azione: 'lettura pagamenti candidati' })
    })

    it('pagamenti/fattura/sync: rilettura delle quote fallita → NON scrive uno stato inventato sul pagamento', async () => {
        // La lettura più velenosa: il suo fallimento non si limita a tacere, SCRIVE IL FALSO.
        // Con `tutte` a null, `aggregaFatturaStato([])` vale `in_attesa` → il pagamento di una
        // fattura appena consegnata verrebbe riscritto «in attesa», con conseguenze fiscali.
        db.state.code = {
            fatture_emesse: [
                { data: [{ id: 'f1', pagamento_id: 'p1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'IT_a.xml.p7m', sdi_stato: 1 }] },
                { data: null }, // l'UPDATE della fattura: passa
                { error: DB_IN_AFFANNO }, // la RILETTURA delle quote: cade
            ],
            admin_settings: [{ data: { aruba_config: { abilitato: true, ambiente: 'demo', username: 'u' } } }],
        }

        const res = await fatturaPOST(req('http://localhost/api/pagamenti/fattura/sync', SEGRETO))

        expect(res.status).toBe(500)
        expect(battitoOk()).toBe(false)
        // LA RIGA CHE CONTA: il pagamento non viene toccato. Un aggregato calcolato su una
        // lettura fallita non è un aggregato: è un'invenzione.
        expect(chiamate('pagamenti', 'update')).toBe(0)
        expect(errori()[0]).toMatchObject({
            esito: 'query-fallita',
            azione: 'rilettura quote fattura',
            scuola_id: SCUOLA,
        })
    })

    it('notifiche/promemoria: una scansione caduta → il giro NON è «ok» (500 + giro-incompleto)', async () => {
        // Qui le tre scansioni restano best-effort — una che cade non impedisce alle altre due di
        // girare — ma il battito di CHIUSURA non è best-effort: con i contatori a zero perché una
        // scansione è morta, un «ok» direbbe «non c'era niente da ricordare» invece di «non ho
        // guardato». Le due frasi si leggono uguali e significano l'opposto.
        db.state.code = {
            avvisi: [{ error: DB_IN_AFFANNO }],
            locker_requests: [{ data: [] }],
            student_documents: [{ data: [] }],
        }

        const res = await promemoriaPOST(req('http://localhost/api/notifiche/promemoria', SEGRETO))

        expect(res.status).toBe(500)
        expect(battitoOk()).toBe(false)
        const e = errori()
        expect(e).toEqual([
            expect.objectContaining({ esito: 'scansione-fallita', azione: 'moduli' }),
            expect.objectContaining({ esito: 'giro-incompleto', azione: 'moduli' }),
        ])
    })

    it('notifiche/promemoria: tabella assente (DB E2E non migrato) resta un «ok» — non è un guasto', async () => {
        // Regressione da non introdurre: il DB della CI E2E è un progetto separato mai migrato
        // (memoria `e2e_ci_db_migration_drift`). Lì le tabelle mancano davvero, e assorbire lo
        // schema drift è VOLUTO — è un DB non migrato, non un job rotto. Il fix deve gridare su
        // un DB in affanno e tacere su un DB non migrato: sono due cose diverse.
        db.state.code = {
            avvisi: [{ error: TABELLA_ASSENTE }],
            locker_requests: [{ error: TABELLA_ASSENTE }],
            student_documents: [{ error: TABELLA_ASSENTE }],
        }

        const res = await promemoriaPOST(req('http://localhost/api/notifiche/promemoria', SEGRETO))

        expect(res.status).toBe(200)
        expect(battitoOk()).toBe(true)
        expect(errori()).toHaveLength(0)
    })

    it('il giro sano continua a chiudere con «ok» (il fix non grida a vuoto)', async () => {
        db.state.code = { notifiche: [{ data: [] }] }

        const res = await dispatchPOST(req('http://localhost/api/push/dispatch', SEGRETO))

        expect(res.status).toBe(200)
        expect(battitoOk()).toBe(true)
        expect(errori()).toHaveLength(0)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('DIFETTO 2 — il POST anonimo non fabbrica il segnale «cron rotto»', () => {
    const route = CRON

    it.each(route)('%s: POST anonimo → 401 e NESSUNA riga error persistita', async (_nome, POST, url) => {
        const res = await POST(req(url))

        // Il 401 non cambia: il gate resta quello di prima (lock `cron-secret.test.ts`).
        expect(res.status).toBe(401)
        // Ma nessuna riga `error`. Queste route sono pubbliche e senza rate-limit: un bot che
        // bussa 10.000 volte scriverebbe 10.000 righe «il cron è rotto» in `app_log`, rendendo
        // l'allarme VERO indistinguibile dal rumore. Un allarme rumoroso si smette di guardare —
        // ed è così che il guasto vero passa inosservato.
        expect(errori()).toHaveLength(0)
    })

    it.each(route)('%s: header presente ma sbagliato → 401 e la riga error CI DEVE essere', async (_nome, POST, url) => {
        const res = await POST(req(url, 'chiave-sbagliata'))

        expect(res.status).toBe(401)
        // Questo è il caso che la riga esiste per portare: un cron che bussa con la chiave
        // sbagliata (il secret nel Vault del DB non combacia più con quello di Vercel). Da fuori
        // è indistinguibile da un cron che non gira — e senza questa riga resterebbe invisibile.
        expect(errori()).toEqual([expect.objectContaining({ esito: 'secret-errato' })])
    })

    it('la riga «secret-errato» finisce DAVVERO in tabella — è per questo che l\'anonimo non la scrive', async () => {
        // Il resto del file asserisce sulle CHIAMATE al logger. Questo test chiude il cerchio con
        // il `vaPersistito` VERO (non la spia): dimostra che una riga `error` su evento `cron`
        // viene persistita in `app_log`. Cioè: senza il fix, ogni `curl` anonimo sarebbe una
        // scrittura sul database di produzione. Se un domani `cron` uscisse da `EVENTI_PERSISTITI`
        // o cambiasse la politica dei livelli, è qui che ce ne accorgeremmo.
        const logger = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger')

        expect(logger.vaPersistito('error', 'cron')).toBe(true)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('DIFETTO 3 — il fallimento TOTALE del job resta un battito «cron», non un «unhandled»', () => {
    /**
     * IL GUASTO PEGGIORE NON PUÒ ESSERE L'UNICO CHE LA SORVEGLIANZA NON VEDE.
     *
     * `createAdminClient()` è il primo pezzo di mondo esterno che ogni cron tocca, e costruisce
     * il client con `SUPABASE_SERVICE_ROLE_KEY!`: quel `!` è una promessa al type-checker, non al
     * runtime. Con la chiave assente o ruotata male — env var non propagata a un ambiente,
     * rotazione fatta a metà — `createServerClient` LANCIA, e da lì non gira più niente: nessuna
     * scansione, nessuna query, nessun promemoria.
     *
     * Senza un try/catch esterno l'eccezione risale a Next, che risponde 500 e la registra via
     * `onRequestError` — cioè con `evento: 'unhandled'`. Sembra una questione di etichette, ed è
     * invece il buco: chi sorveglia i cron interroga `where evento = 'cron'`, perché è lì che
     * vivono i battiti. Il fallimento totale — l'unico che fa sparire TUTTI i battiti insieme —
     * sarebbe l'unico a finire in un flusso diverso, cioè l'unico che quella query non trova. Il
     * giro potrebbe morire ogni notte lasciando come sola traccia un 'avviato' senza 'ok': un
     * segnale che si legge solo per ASSENZA, e solo da chi già sospetta.
     *
     * `notifiche/promemoria` era l'unico dei cinque senza questa rete. Il lock gira su tutti e
     * cinque: la rete o ce l'hanno tutti, o domani il prossimo cron nascerà di nuovo senza.
     */
    it.each(CRON)('%s: il client admin lancia → 500 e riga evento «cron» (non un\'eccezione nuda)', async (_nome, POST, url) => {
        // Il messaggio è quello VERO di supabase-js quando la service-role key non c'è.
        const guasto = new Error('supabaseKey is required.')
        supa.createAdminClient.mockRejectedValueOnce(guasto)

        // Che questa `await` RESTITUISCA una Response invece di rigettare È già metà del test:
        // prima del fix, su promemoria, l'eccezione usciva nuda dall'handler.
        const res = await POST(req(url, SEGRETO))

        expect(res.status).toBe(500)
        // Nessun «ok»: il giro non ha fatto niente, e non deve dire il contrario.
        expect(battitoOk()).toBe(false)

        // La riga esce da `logErrore` — che emette anche l'Error nativo con lo stack VERO, quello
        // che dice in quale riga si è rotto: una riga logfmt da sola non lo porterebbe.
        expect(log.logErrore).toHaveBeenCalledTimes(1)
        const [campi, err] = log.logErrore.mock.calls[0] as [Record<string, unknown>, unknown]
        // `evento: 'cron'` È IL PUNTO: rimette il guasto peggiore nello stesso flusso in cui chi
        // sorveglia sta già guardando. `stato: 500` lo rende interrogabile in SQL senza incrociare
        // i log di piattaforma.
        expect(campi).toMatchObject({ evento: 'cron', stato: 500 })
        expect(campi.operazione).toBeTypeOf('string')
        // Il corpo dell'errore non si butta MAI via (regola 3): l'errore vero viaggia nel 2°
        // argomento, o la riga direbbe che il job è morto senza dire di cosa.
        expect(err).toBe(guasto)
    })
})
