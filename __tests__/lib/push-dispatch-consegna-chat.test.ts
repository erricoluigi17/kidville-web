import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * D1 — «CONSEGNATO» QUANDO IL PROVIDER DELLE PUSH ACCETTA LA NOTIFICA (passo 6).
 *
 * Una mamma ha visto per cinque ore una spunta sola e ha creduto che il messaggio non fosse
 * arrivato. Le strade della consegna sono due: D2 (l'app di chi riceve è aperta, e la campanella
 * consegna con `consegnaSeInAttesa`) e D1, questa — con l'app chiusa, il dispatcher manda la push
 * e il provider la ACCETTA (FCM 200, web-push 201). Da quel momento i messaggi di quella
 * conversazione, nati fino alla notifica, sono consegnati.
 *
 * ⚠️ Un 200 di FCM, o il 201 del web-push, vuol dire consegnato ad Apple, Google o al servizio
 * del browser: NON è la conferma del telefono. È la stessa approssimazione che fa qualunque app
 * di messaggistica, ed è dichiarata qui e nella testata del dispatcher invece di essere nascosta.
 *
 * IL FINTO NON È PIATTO. `notifiche` e `push_subscriptions` sono tabelle IN MEMORIA e il client
 * finto APPLICA i filtri che il codice gli passa, letture e UPDATE compresi: così la presa
 * atomica e il ritorno in coda si comportano come in Postgres, e l'ordine delle scritture si
 * misura per quello che è. `@/lib/chat/delivered` invece è sostituito: quello che questo file
 * deve misurare è CHI, QUANDO e CON QUALE `creatiFinoA` viene chiamato — non il suo UPDATE, che
 * ha i suoi test in `__tests__/lib/chat-delivered*.test.ts`.
 *
 * Utenti, thread, sottoscrizioni e testi palesemente finti: nessun dato reale.
 */

type Riga = Record<string, unknown>

const mem = vi.hoisted(() => {
    const st = {
        notifiche: [] as Riga[],
        push_subscriptions: [] as Riga[],
        utenti: {} as Record<string, { role: string; ruolo: string }>,
        /**
         * La sequenza delle scritture del giro. Serve a un solo scopo, ed è un contratto:
         * la consegna della chat viene DOPO il ritorno in coda e la rimozione, non prima.
         */
        ordine: [] as string[],
        /**
         * L'UPDATE di `notifiche` il cui payload soddisfa `se` NON tocca nessuna riga e risponde
         * `{ data: null, error }`, come fa PostgREST (che non lancia). Serve al giro che chiude in
         * 500: la consegna va fatta comunque, perché le push sono già partite.
         */
        erroreUpdate: null as null | { se: (payload: Riga) => boolean; errore: unknown },
    }

    function valore(r: Riga, col: string): unknown {
        return r[col] ?? null
    }

    function parseOr(expr: string): (r: Riga) => boolean {
        const parti = expr.split(',').map((p) => {
            const [col, op, ...resto] = p.split('.')
            const v = resto.join('.')
            if (op === 'is' && v === 'null') return (r: Riga) => valore(r, col) === null
            if (op === 'lte') return (r: Riga) => valore(r, col) !== null && Date.parse(String(valore(r, col))) <= Date.parse(v)
            throw new Error(`or() non supportato dal finto: ${p}`)
        })
        return (r) => parti.some((f) => f(r))
    }

    class Query {
        op: 'select' | 'update' | 'delete' = 'select'
        payload: Riga = {}
        restituisce = false
        filtri: Array<(r: Riga) => boolean> = []
        ordine: { col: string; asc: boolean } | null = null
        limite = Infinity
        constructor(readonly tabella: 'notifiche' | 'push_subscriptions') {}
        select() {
            if (this.op === 'update') this.restituisce = true
            return this
        }
        update(p: Riga) {
            this.op = 'update'
            this.payload = p
            return this
        }
        delete() {
            this.op = 'delete'
            return this
        }
        is(col: string, v: null) {
            this.filtri.push((r) => valore(r, col) === v)
            return this
        }
        eq(col: string, v: unknown) {
            this.filtri.push((r) => valore(r, col) === v)
            return this
        }
        in(col: string, vs: unknown[]) {
            this.filtri.push((r) => vs.includes(valore(r, col)))
            return this
        }
        or(expr: string) {
            this.filtri.push(parseOr(expr))
            return this
        }
        order(col: string, o?: { ascending?: boolean }) {
            this.ordine = { col, asc: o?.ascending !== false }
            return this
        }
        limit(n: number) {
            this.limite = n
            return this
        }
        private esegui(): { data: unknown; error: unknown } {
            const righe = st[this.tabella]
            const tocca = righe.filter((r) => this.filtri.every((f) => f(r)))
            if (this.op === 'update') {
                if (this.tabella === 'notifiche' && st.erroreUpdate?.se(this.payload)) {
                    return { data: null, error: st.erroreUpdate.errore }
                }
                for (const r of tocca) Object.assign(r, this.payload)
                if (this.tabella === 'notifiche') {
                    st.ordine.push(this.payload.push_inviata_il === null ? 'ritorno-in-coda' : 'presa')
                }
                return { data: this.restituisce ? tocca.map((r) => ({ id: r.id })) : null, error: null }
            }
            if (this.op === 'delete') {
                st[this.tabella] = righe.filter((r) => !tocca.includes(r))
                st.ordine.push('rimozione-dispositivi')
                return { data: null, error: null }
            }
            let out = [...tocca]
            if (this.ordine) {
                const { col, asc } = this.ordine
                out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
            }
            out = out.slice(0, this.limite)
            return {
                data: out.map((r) =>
                    this.tabella === 'notifiche' ? { ...r, utenti: st.utenti[String(r.utente_id)] ?? null } : { ...r },
                ),
                error: null,
            }
        }
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
            return Promise.resolve(this.esegui()).then(res, rej)
        }
    }

    function client() {
        return {
            from: (t: 'notifiche' | 'push_subscriptions') => new Query(t),
            // Nessun iPhone nei casi di questo file: la RPC del badge non serve, ma se il codice
            // la chiamasse deve trovare una risposta valida invece di un `undefined`.
            async rpc() {
                return { data: [], error: null }
            },
        }
    }

    return { st, client }
})

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn(async () => mem.client()) }))
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
const web = vi.hoisted(() => ({ sendPush: vi.fn(), vapidConfigured: vi.fn() }))
vi.mock('@/lib/push/web-push', () => web)
const native = vi.hoisted(() => ({ sendNativePush: vi.fn(), fcmConfigured: vi.fn() }))
vi.mock('@/lib/push/native-push', () => native)
// La factory espone i DUE export del modulo, come gli altri file che lo sostituiscono: un import
// nuovo da `@/lib/chat/delivered` non deve far esplodere questo file con «No export is defined».
const consegnato = vi.hoisted(() => ({ marcaConsegnati: vi.fn(), consegnaSeInAttesa: vi.fn() }))
vi.mock('@/lib/chat/delivered', () => consegnato)

import { eseguiDispatch, FINESTRA_CODA_MS, SOGLIA_CONSEGNA_CHAT_MS, TIPI_CHAT, type DatiDispatch } from '@/lib/push/dispatch'
import { ENTITA_CHAT_THREAD } from '@/lib/chat/notifiche-chat'
import { createAdminClient } from '@/lib/supabase/server-client'

const MIN = 60_000
const iso = (msFa: number) => new Date(Date.now() - msFa).toISOString()
/** Il sorgente senza commenti (blocco e riga intera): un lock non si immunizza col proprio commento. */
const senzaCommenti = (sorgente: string) => sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const TH1 = 'thread-finto-1'
const TH2 = 'thread-finto-2'

function notifica(id: string, utente_id: string, extra: Riga = {}): Riga {
    return {
        id,
        utente_id,
        tipo: 'avviso_generico',
        titolo: `titolo-${id}`,
        corpo: null,
        link: '/x',
        entita_tipo: null,
        entita_id: null,
        letta_il: null,
        push_inviata_il: null,
        creato_il: iso(2 * MIN),
        invio_programmato_il: iso(MIN),
        ...extra,
    }
}

/** Una notifica di chat come la scrive `chat/messages:POST`: tipo di chat, entità = thread. */
function chat(id: string, utente_id: string, threadId: string, extra: Riga = {}): Riga {
    return notifica(id, utente_id, {
        tipo: 'chat_genitore',
        titolo: 'Nuovo messaggio in chat',
        corpo: 'Hai un nuovo messaggio da Mittente Finto',
        entita_tipo: ENTITA_CHAT_THREAD,
        entita_id: threadId,
        ...extra,
    })
}

const subWeb = (id: string, utente_id: string): Riga => ({
    id,
    utente_id,
    endpoint: `endpoint-${id}`,
    p256dh: 'p',
    auth: 'a',
    platform: 'web',
})
const subNativa = (id: string, utente_id: string, platform: 'ios' | 'android'): Riga => ({
    id,
    utente_id,
    endpoint: `token-${id}`,
    p256dh: null,
    auth: null,
    platform,
})

const riga = (id: string) => mem.st.notifiche.find((r) => r.id === id)!
const dati = (e: Awaited<ReturnType<typeof eseguiDispatch>>): DatiDispatch => {
    expect(e.stato).toBe(200)
    return (e as { data: DatiDispatch }).data
}
const righeLog = (livello: string, esito: string) =>
    log.logEvento.mock.calls.filter((c) => c[1] === livello && (c[2] as Riga).esito === esito).map((c) => c[2] as Riga)
/** Le chiamate a `marcaConsegnati`, solo il secondo argomento (i parametri). */
const consegne = () => consegnato.marcaConsegnati.mock.calls.map((c) => c[1] as Record<string, unknown>)
/**
 * Il finto di `marcaConsegnati`: registra l'ordine e dice quante righe ha acceso. Il contratto è
 * `{ esito, n }` e non `void` proprio perché il dispatcher deve contare le RIGHE, non le chiamate.
 */
const consegnaOk = (n = 1) => async () => {
    mem.st.ordine.push('consegna-chat')
    return { esito: 'ok' as const, n }
}

const TRANSITORIO = { ok: false, error: 'fcm_503: {"error":{"status":"UNAVAILABLE"}}', ritentabile: true, tentativi: 3 }
const DEFINITIVO = { ok: false, error: 'fcm_400: {"error":{"status":"INVALID_ARGUMENT"}}', ritentabile: false, tentativi: 1 }

beforeEach(() => {
    vi.clearAllMocks()
    mem.st.notifiche = []
    mem.st.push_subscriptions = []
    mem.st.utenti = {}
    mem.st.ordine = []
    mem.st.erroreUpdate = null
    web.vapidConfigured.mockReturnValue(true)
    web.sendPush.mockResolvedValue({ ok: true })
    native.fcmConfigured.mockReturnValue(true)
    native.sendNativePush.mockResolvedValue({ ok: true, tentativi: 1 })
    consegnato.marcaConsegnati.mockImplementation(consegnaOk(1))
})

afterEach(() => {
    vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('il provider ha accettato la push di chat: i messaggi di quel thread sono consegnati', () => {
    it('i tipi di chat su cui gira il caso qui sotto non sono un elenco vuoto', () => {
        // `it.each([])` non genera nessun caso: senza questa riga, un `TIPI_CHAT` svuotato
        // lascerebbe il file verde avendo provato zero tipi.
        expect(TIPI_CHAT.length).toBeGreaterThan(0)
    })

    it.each([...TIPI_CHAT])('tipo `%s`: UNA chiamata con destinatario, il suo thread e `creatiFinoA` = `creato_il`', async (tipo) => {
        const nato = iso(90_000)
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1, { tipo, creato_il: nato })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(web.sendPush).toHaveBeenCalledTimes(1)
        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(1)
        // Il client è LO STESSO del giro, non un secondo aperto per la consegna: `toBeDefined()`
        // passerebbe con qualunque oggetto, anche con un client nuovo — e un secondo
        // `createAdminClient` in un giro da 500 notifiche è una connessione in più per niente.
        expect(consegnato.marcaConsegnati.mock.calls[0][0]).toBe(
            await (createAdminClient as unknown as { mock: { results: Array<{ value: unknown }> } }).mock.results[0].value,
        )
        // `conteggia: true`: senza il conteggio, `n` sarebbe sempre 0 e il contatore delle righe
        // accese non potrebbe distinguere «consegnate 40» da «nessuna riga toccata».
        expect(consegne()[0]).toEqual({ userId: 'u-mamma', threadIds: [TH1], creatiFinoA: nato, conteggia: true })
        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_righe: 1, consegne_chat_saltate: 0, notifiche: 1 })
    })

    it('`creatiFinoA` viaggia TALE E QUALE, coi microsecondi di PostgREST', async () => {
        // PostgREST restituisce `2026-09-30T08:12:33.567891+00:00`: un `new Date(ms).toISOString()`
        // per strada lo troncherebbe al millisecondo, spostando la linea del tempo di 891 µs
        // INDIETRO — il lato sicuro (può solo lasciare spenta la spunta di un messaggio nato in
        // quella frazione prima della notifica), ma comunque una linea diversa da quella vera.
        const preciso = '2026-09-30T08:12:33.567891+00:00'
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1, { creato_il: preciso })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(consegne()[0].creatiFinoA).toBe(preciso)
        expect(d.consegne_chat).toBe(1)
    })

    it('il contatore delle RIGHE è quello che `marcaConsegnati` dice, non il numero di chiamate', async () => {
        // Il difetto che questa correzione toglie: con l'app aperta D2 consegna per primo, l'UPDATE
        // di D1 tocca ZERO righe e un contatore di chiamate direbbe «acceso» per sempre, anche con
        // D1 rotto. Qui le due coppie accendono 4 e 0 righe: i numeri devono essere diversi.
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-papa', TH2)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subWeb('s2', 'u-papa')]
        consegnato.marcaConsegnati.mockImplementationOnce(consegnaOk(4)).mockImplementationOnce(consegnaOk(0))

        const d = dati(await eseguiDispatch())

        expect(d).toMatchObject({ consegne_chat: 2, consegne_chat_righe: 4 })
        expect(righeLog('info', 'ok')[0]).toMatchObject({ consegne_chat: 2, consegne_chat_righe: 4 })
    })

    it('tutte le coppie a ZERO righe: consegne contate, righe zero (nessuna spunta accesa da noi)', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati.mockImplementation(consegnaOk(0))

        const d = dati(await eseguiDispatch())

        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_righe: 0 })
    })

    it('anche con la push NATIVA accettata (FCM 200): la consegna è dell\'accettazione, non del canale', async () => {
        mem.st.notifiche = [chat('n1', 'u-papa', TH1, { tipo: 'chat_docente' })]
        mem.st.push_subscriptions = [subNativa('s1', 'u-papa', 'android')]

        const d = dati(await eseguiDispatch())

        expect(native.sendNativePush).toHaveBeenCalledTimes(1)
        expect(consegne()).toEqual([{ userId: 'u-papa', threadIds: [TH1], creatiFinoA: riga('n1').creato_il, conteggia: true }])
        expect(d.consegne_chat).toBe(1)
    })

    it('la chat allo staff che la riceve si consegna come a un genitore', async () => {
        // I tipi della chat sono l'eccezione a `RUOLI_PUSH_SOLO_CODA`: la push parte, quindi la
        // doppia spunta si accende anche quando chi legge è la segreteria.
        mem.st.utenti = { 'u-segr': { role: 'segreteria', ruolo: 'segreteria' } }
        mem.st.notifiche = [chat('n1', 'u-segr', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-segr')]

        const d = dati(await eseguiDispatch())

        expect(web.sendPush).toHaveBeenCalledTimes(1)
        expect(d).toMatchObject({ consegne_chat: 1, escluse_staff: 0 })
    })

    it('un destinatario con DUE thread: due chiamate, ognuna col `finoA` della SUA notifica', async () => {
        // Il mutante che raggruppa per destinatario e prende il `finoA` massimo passerebbe con una
        // chiamata sola: consegnerebbe nel thread più vecchio anche i messaggi nati dopo la sua
        // notifica — messaggi che hanno una notifica loro, ancora da spedire. Doppia spunta falsa.
        const vecchio = iso(5 * MIN)
        const recente = iso(MIN)
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1, { creato_il: vecchio }),
            chat('n2', 'u-mamma', TH2, { creato_il: recente }),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(2)
        expect(consegne()).toEqual([
            { userId: 'u-mamma', threadIds: [TH1], creatiFinoA: vecchio, conteggia: true },
            { userId: 'u-mamma', threadIds: [TH2], creatiFinoA: recente, conteggia: true },
        ])
        expect(d.consegne_chat).toBe(2)
    })

    it('due notifiche per la STESSA coppia: una chiamata sola, col `creato_il` più RECENTE', async () => {
        const vecchio = iso(5 * MIN)
        const recente = iso(MIN)
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1, { creato_il: vecchio }),
            chat('n2', 'u-mamma', TH1, { creato_il: recente }),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(web.sendPush).toHaveBeenCalledTimes(2)
        expect(consegne()).toEqual([{ userId: 'u-mamma', threadIds: [TH1], creatiFinoA: recente, conteggia: true }])
        expect(d.consegne_chat).toBe(1)
    })

    it('lo stesso thread a DUE destinatari: due chiamate, una per persona', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-maestra', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subWeb('s2', 'u-maestra')]

        const d = dati(await eseguiDispatch())

        expect(consegne().map((c) => c.userId).sort()).toEqual(['u-maestra', 'u-mamma'])
        expect(consegne().every((c) => (c.threadIds as string[])[0] === TH1)).toBe(true)
        expect(d.consegne_chat).toBe(2)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('nessun dispositivo ha ricevuto la push: NESSUNA consegna', () => {
    it('rifiuti transitori entro 30\': la notifica torna in coda e non si consegna niente', async () => {
        // Se si consegnasse qui, la doppia spunta si accenderebbe su un messaggio che non è
        // arrivato da nessuna parte: la stessa bugia di prima, rovesciata.
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1, { invio_programmato_il: iso(5 * MIN) })]
        mem.st.push_subscriptions = [subNativa('s1', 'u-mamma', 'android')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(riga('n1').push_inviata_il).toBeNull()
        expect(d).toMatchObject({ rimesse_in_coda: 1, consegne_chat: 0, consegne_chat_saltate: 0 })
    })

    it('rifiuto DEFINITIVO: la notifica resta marcata, ma nessuna consegna', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subNativa('s1', 'u-mamma', 'android')]
        native.sendNativePush.mockResolvedValue(DEFINITIVO)

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(riga('n1').push_inviata_il).not.toBeNull()
        expect(d).toMatchObject({ notifiche: 1, fallite: 1, consegne_chat: 0 })
    })

    it('arresa dopo 30\' di errori transitori: marcata, mai consegnata a nessuno, nessuna consegna', async () => {
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1, {
                creato_il: iso(FINESTRA_CODA_MS + 2 * MIN),
                invio_programmato_il: iso(FINESTRA_CODA_MS + MIN),
            }),
        ]
        mem.st.push_subscriptions = [subNativa('s1', 'u-mamma', 'android')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d).toMatchObject({ arrese: 1, consegne_chat: 0 })
    })

    it('nessun dispositivo iscritto: nessuna consegna (la push non è mai partita)', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = []

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d).toMatchObject({ notifiche: 1, consegne_chat: 0 })
    })

    it('solo dispositivi morti (410/404): si rimuovono, e nessuna consegna', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        web.sendPush.mockResolvedValue({ ok: false, gone: true })

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d).toMatchObject({ subs_rimosse: 1, consegne_chat: 0 })
    })

    it('un dispositivo su due l\'ha ricevuta: SI consegna (basta un telefono acceso)', async () => {
        // Il controllo positivo dei quattro casi qui sopra: il `ricevute > 0` non è «tutti».
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subNativa('s1', 'u-mamma', 'android'), subWeb('s2', 'u-mamma')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)

        const d = dati(await eseguiDispatch())

        expect(consegne()).toEqual([{ userId: 'u-mamma', threadIds: [TH1], creatiFinoA: riga('n1').creato_il, conteggia: true }])
        expect(d).toMatchObject({ inviate: 1, consegne_chat: 1 })
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('solo le notifiche DI CHAT, e solo quelle che portano il thread', () => {
    it('un tipo che non è di chat, anche con entità `chat_thread`: nessuna consegna', async () => {
        mem.st.notifiche = [
            notifica('n1', 'u-mamma', { tipo: 'avviso_generico', entita_tipo: ENTITA_CHAT_THREAD, entita_id: TH1 }),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(web.sendPush).toHaveBeenCalledTimes(1)
        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d.consegne_chat).toBe(0)
    })

    it('tipo di chat ma `entita_tipo` di un\'altra entità: nessuna consegna', async () => {
        // L'`entita_id` sarebbe l'uuid di un'altra cosa: marcare consegnato un «thread» che è un
        // avviso non troverebbe righe, ma è un UPDATE a vuoto sul DB di produzione a ogni giro.
        mem.st.notifiche = [chat('n1', 'u-mamma', 'uuid-di-un-avviso', { entita_tipo: 'avviso' })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d.consegne_chat).toBe(0)
    })

    it('tipo di chat con `entita_id` nullo: nessuna consegna', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1, { entita_id: null })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d.consegne_chat).toBe(0)
    })

    it('senza `creato_il` non si consegna: senza la linea del tempo la spunta sarebbe falsa', async () => {
        // `creatiFinoA` assente = nessun filtro temporale, cioè TUTTO il thread consegnato, anche
        // i messaggi nati dopo questa notifica. Meglio una spunta in ritardo (la accende D2, o
        // l'apertura della lista) che una spunta bugiarda.
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1, { creato_il: null })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const d = dati(await eseguiDispatch())

        expect(web.sendPush).toHaveBeenCalledTimes(1)
        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d.consegne_chat).toBe(0)
    })

    it('la lettura delle candidate chiede `entita_tipo` e `entita_id` nella STESSA query', async () => {
        // Il caso che tiene in piedi tutti gli altri: il finto restituisce le colonne che ha in
        // memoria qualunque cosa chieda il `select`. Senza questo controllo, togliere i due campi
        // dalla lettura lascerebbe verde tutto il resto e spegnerebbe la consegna in produzione.
        // Si legge il sorgente della `select`: il finto non può testimoniare per lei. SENZA i
        // commenti, perché un lock che legge un file come testo legge anche i propri commenti: la
        // riga qui sopra che nomina `entita_tipo` non deve poter tenere verde il lock da sola.
        const sorgente = senzaCommenti(readFileSync(join(process.cwd(), 'src', 'lib', 'push', 'dispatch.ts'), 'utf8'))
        const select = sorgente.match(/\.select\('id, utente_id[^']*'\)/)
        expect(select).not.toBeNull()
        expect(select![0]).toContain('entita_tipo')
        expect(select![0]).toContain('entita_id')
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('il tetto di tempo della consegna: le rimanenti le accende D2', () => {
    it('la soglia scatta fra una coppia e l\'altra: la seconda è SALTATA, non tentata', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati.mockImplementationOnce(async () => {
            mem.st.ordine.push('consegna-chat')
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS + 1_000)
            return { esito: 'ok' as const, n: 1 }
        })

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(1)
        expect(consegne()[0]).toMatchObject({ threadIds: [TH1] })
        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_saltate: 1, notifiche: 2 })
    })

    it('TRE coppie, la soglia scatta dopo la prima: DUE saltate, anche nel battito', async () => {
        // Proposto dal revisore di qualità (E1). Con due numeri DIVERSI fra i contatori, uno
        // scambio nel battito non passa più; e un `break` che smettesse di contare lascerebbe
        // `consegne_chat_saltate: 0`, cioè due spunte mai accese e nessuna traccia.
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2), chat('n3', 'u-mamma', 'thread-finto-3')]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS + 1_000)
            return { esito: 'ok' as const, n: 1 }
        })

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(1)
        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_saltate: 2 })
        expect(righeLog('info', 'ok')[0]).toMatchObject({ consegne_chat: 1, consegne_chat_saltate: 2 })
    })

    it('le coppie saltate hanno una riga `warn` in `app_log`, con quante sono', async () => {
        // Senza la riga, il salto si vedrebbe SOLO nel battito `info` — che sul canale `push` è
        // persistito, ma resta un numero dentro venti. E non è vero che basti `tetto-di-tempo`: a
        // 80 s si arriva anche senza sforare il tetto del giro, per esempio con un'ultima notifica
        // lunga o con un arretrato di coppie da consegnare.
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS + 1_000)
            return { esito: 'ok' as const, n: 2 }
        })

        await eseguiDispatch()

        const saltate = righeLog('warn', 'consegna-chat-saltata')
        expect(saltate).toHaveLength(1)
        expect(saltate[0]).toMatchObject({ consegne_chat_saltate: 1, consegne_chat: 1, consegne_chat_righe: 2 })
        // Il giro NON ha superato `TETTO_GIRO_MS`: la riga del tetto non c'è, e questa sì.
        expect(righeLog('warn', 'tetto-di-tempo')).toEqual([])
    })

    it('nessuna coppia saltata → nessuna riga `consegna-chat-saltata`', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        await eseguiDispatch()
        expect(righeLog('warn', 'consegna-chat-saltata')).toEqual([])
    })

    it('il giro arriva alla consegna GIÀ oltre la soglia: nessuna chiamata, tutte saltate', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        web.sendPush.mockImplementation(async () => {
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS + 1_000)
            return { ok: true }
        })

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).not.toHaveBeenCalled()
        expect(d).toMatchObject({ consegne_chat: 0, consegne_chat_saltate: 1, notifiche: 1 })
    })

    it('sotto la soglia non scatta niente: il contrario del caso sopra', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        web.sendPush.mockImplementation(async () => {
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS - 1_000)
            return { ok: true }
        })

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(1)
        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_saltate: 0 })
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('la consegna è accessoria: non ritarda le scritture che salvano le notifiche, e non rompe il giro', () => {
    it('la consegna viene DOPO il ritorno in coda', async () => {
        // Il ritorno in coda è la scrittura che impedisce di PERDERE una notifica presa e non
        // consegnata («IL PREZZO DELLA PRESA»). La doppia spunta è un contorno: se la consegna
        // andasse prima, un UPDATE lento su `chat_messages` ruberebbe il tempo che serve a salvare
        // le notifiche, e una Function troncata in mezzo le lascerebbe marcate e mai spedite.
        mem.st.notifiche = [
            // Ricevuta → si consegna.
            chat('n1', 'u-mamma', TH1),
            // Rifiutata con errore transitorio → torna in coda.
            chat('n2', 'u-papa', TH2, { invio_programmato_il: iso(5 * MIN) }),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subNativa('s2', 'u-papa', 'android')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)

        const d = dati(await eseguiDispatch())

        expect(d).toMatchObject({ consegne_chat: 1, rimesse_in_coda: 1 })
        expect(mem.st.ordine).toEqual(['presa', 'ritorno-in-coda', 'consegna-chat'])
    })

    it('la consegna viene dopo il ritorno in coda E dopo la rimozione dei dispositivi morti', async () => {
        // Proposto dal revisore (E2). Il caso sopra non distingue «dopo il ritorno» da «prima della
        // rimozione»: un dispositivo morto che resta in tabella riprova a ricevere una push che non
        // arriverà mai, a ogni giro, per sempre. Anche quella cancellazione viene prima.
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1),
            chat('n2', 'u-papa', TH2, { invio_programmato_il: iso(5 * MIN) }),
            chat('n3', 'u-zia', 'thread-finto-3'),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subNativa('s2', 'u-papa', 'android'), subWeb('s3', 'u-zia')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)
        web.sendPush.mockImplementation(async (s: { endpoint: string }) =>
            s.endpoint === 'endpoint-s3' ? { ok: false, gone: true } : { ok: true },
        )

        const d = dati(await eseguiDispatch())

        expect(d).toMatchObject({ consegne_chat: 1, rimesse_in_coda: 1, subs_rimosse: 1 })
        expect(mem.st.ordine).toEqual(['presa', 'ritorno-in-coda', 'rimozione-dispositivi', 'consegna-chat'])
    })

    it('giro MISTO: si consegna SOLO il thread la cui notifica è stata ricevuta', async () => {
        // Proposto dal revisore (E3), ed è l'invariante di tutto il passo provato con più notifiche
        // nello stesso giro. Uccide il difetto peggiore possibile: leggere i contatori del GIRO
        // (`inviate + native_inviate > 0`) invece di quelli della notifica. Basterebbe una sola
        // notifica ricevuta prima per accendere la spunta sulle altre TRE che nessuno ha ricevuto.
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1, { creato_il: iso(4 * MIN) }),
            chat('n2', 'u-papa', TH2, { creato_il: iso(3 * MIN) }),
            chat('n3', 'u-zia', 'thread-finto-3', { creato_il: iso(2 * MIN) }),
            chat('n4', 'u-nonno', 'thread-finto-4', { creato_il: iso(MIN) }),
        ]
        // u-mamma riceve; u-papa rifiuto definitivo; u-zia nessun dispositivo; u-nonno solo morti.
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subNativa('s2', 'u-papa', 'android'), subWeb('s4', 'u-nonno')]
        native.sendNativePush.mockResolvedValue(DEFINITIVO)
        web.sendPush.mockImplementation(async (s: { endpoint: string }) =>
            s.endpoint === 'endpoint-s4' ? { ok: false, gone: true } : { ok: true },
        )

        const d = dati(await eseguiDispatch())

        expect(consegne()).toEqual([
            { userId: 'u-mamma', threadIds: [TH1], creatiFinoA: riga('n1').creato_il, conteggia: true },
        ])
        expect(d).toMatchObject({ consegne_chat: 1, notifiche: 4, inviate: 1, fallite: 1, subs_rimosse: 1 })
    })

    it('un `fermati` di `marcaConsegnati` FERMA il passo: le rimanenti sono saltate', async () => {
        // Un errore del database su una coppia vuol dire che le altre andranno allo stesso modo, e
        // ogni tentativo in più aggiunge un `logErrore` — cioè un'altra scrittura su un database
        // che ha appena risposto male. Il parziale già acceso resta contato.
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2), chat('n3', 'u-mamma', 'thread-finto-3')]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati
            .mockImplementationOnce(consegnaOk(3))
            .mockImplementationOnce(async () => ({ esito: 'fermati' as const, n: 1 }))

        const d = dati(await eseguiDispatch())

        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(2)
        // Una coppia riuscita, 4 righe accese (3 + il parziale della fallita), 2 coppie saltate.
        expect(d).toMatchObject({ consegne_chat: 1, consegne_chat_righe: 4, consegne_chat_saltate: 2 })
        // Il giro chiude bene: il guasto della consegna l'ha già loggato `marcaConsegnati`.
        expect(righeLog('info', 'ok')).toHaveLength(1)
    })

    it('la consegna che RIGETTA non rompe il giro: 200, il battito c\'è, e una riga lo dice', async () => {
        // `marcaConsegnati` non lancia per contratto. Se lo facesse (un client sostituito, un bug
        // del logger), il dispatcher non deve perdere il proprio battito: è l'unica riga che dice
        // se il giro ha spedito.
        consegnato.marcaConsegnati.mockRejectedValue(new Error('imprevisto nella consegna'))
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]

        const e = await eseguiDispatch()
        const d = dati(e)

        expect(d).toMatchObject({ notifiche: 2, inviate: 2, consegne_chat: 0 })
        expect(riga('n1').push_inviata_il).not.toBeNull()
        // Un catch che non logga è un bug: una riga sola col conteggio, non due identiche.
        const rotte = righeLog('warn', 'consegna-chat-non-riuscita')
        expect(rotte).toHaveLength(1)
        expect(rotte[0]).toMatchObject({ consegne_chat_rotte: 2 })
        // E il battito di chiusura c'è comunque.
        expect(righeLog('info', 'ok')).toHaveLength(1)
    })

    it('nessuna consegna rotta → nessuna riga di allarme', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1)]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        await eseguiDispatch()
        expect(righeLog('warn', 'consegna-chat-non-riuscita')).toHaveLength(0)
    })

    it('giro che finisce in 500 (ritorno in coda fallito): la consegna si fa COMUNQUE, e i contatori stanno nella riga d\'errore', async () => {
        // Le push sono partite e i provider le hanno accettate: le spunte vanno accese, qualunque
        // cosa sia andata storta DOPO sulle righe di `notifiche`. E la riga d'errore porta i
        // contatori di ciò che il giro ha comunque fatto — al posto del battito «ok», che non c'è.
        mem.st.erroreUpdate = { se: (p) => p.push_inviata_il === null, errore: { code: '57014', message: 'timeout' } }
        mem.st.notifiche = [
            chat('n1', 'u-mamma', TH1),
            chat('n2', 'u-papa', TH2, { invio_programmato_il: iso(5 * MIN) }),
        ]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subNativa('s2', 'u-papa', 'android')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)
        consegnato.marcaConsegnati.mockImplementation(consegnaOk(5))

        const e = await eseguiDispatch()

        expect(e.stato).toBe(500)
        expect(consegnato.marcaConsegnati).toHaveBeenCalledTimes(1)
        const err = righeLog('error', 'query-fallita')
        expect(err).toEqual([
            expect.objectContaining({ azione: 'ritorno in coda', consegne_chat: 1, consegne_chat_righe: 5 }),
        ])
        expect(righeLog('info', 'ok')).toHaveLength(0)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('i tre contatori viaggiano nel battito, non solo nel valore di ritorno', () => {
    it('il battito porta `consegne_chat`, `consegne_chat_righe` e `consegne_chat_saltate`', async () => {
        // Senza questi numeri nel battito, «le doppie spunte si accendono» resterebbe un'opinione:
        // per saperlo bisognerebbe interrogare il database a mano, cioè non lo saprebbe nessuno.
        // I tre valori sono DIVERSI di proposito: uno scambio fra loro non passa.
        vi.useFakeTimers({ toFake: ['Date'] })
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2), chat('n3', 'u-mamma', 'thread-finto-3')]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + SOGLIA_CONSEGNA_CHAT_MS + 1_000)
            return { esito: 'ok' as const, n: 7 }
        })

        await eseguiDispatch()

        const [battito] = righeLog('info', 'ok')
        expect(battito).toMatchObject({
            operazione: 'push-dispatch',
            consegne_chat: 1,
            consegne_chat_righe: 7,
            consegne_chat_saltate: 2,
        })
    })

    it('un giro senza chat porta i tre contatori a zero, non `undefined`', async () => {
        mem.st.notifiche = [notifica('n1', 'u-mamma')]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        const d = dati(await eseguiDispatch())
        expect(d.consegne_chat).toBe(0)
        expect(d.consegne_chat_righe).toBe(0)
        expect(d.consegne_chat_saltate).toBe(0)
        expect(righeLog('info', 'ok')[0]).toMatchObject({
            consegne_chat: 0,
            consegne_chat_righe: 0,
            consegne_chat_saltate: 0,
        })
    })

    it('un giro a coda vuota li porta a zero anche nel ramo «niente da spedire»', async () => {
        mem.st.notifiche = []
        const d = dati(await eseguiDispatch())
        expect(d).toMatchObject({ consegne_chat: 0, consegne_chat_righe: 0, consegne_chat_saltate: 0 })
    })

    it('il `fermati` del database ha anche lui la sua riga `consegna-chat-saltata`, non solo il tempo', async () => {
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-mamma', TH2), chat('n3', 'u-mamma', 'thread-finto-3')]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma')]
        consegnato.marcaConsegnati
            .mockImplementationOnce(consegnaOk(3))
            .mockImplementationOnce(async () => ({ esito: 'fermati' as const, n: 1 }))

        await eseguiDispatch()

        expect(righeLog('warn', 'consegna-chat-saltata')).toEqual([
            expect.objectContaining({ consegne_chat_saltate: 2, consegne_chat: 1, consegne_chat_righe: 4 }),
        ])
    })

    it('la riga d\'errore del giro che chiude in 500 porta anche `consegne_chat_saltate`', async () => {
        mem.st.erroreUpdate = { se: (p) => p.push_inviata_il === null, errore: { code: '57014', message: 'timeout' } }
        mem.st.notifiche = [chat('n1', 'u-mamma', TH1), chat('n2', 'u-papa', TH2, { invio_programmato_il: iso(5 * MIN) })]
        mem.st.push_subscriptions = [subWeb('s1', 'u-mamma'), subNativa('s2', 'u-papa', 'android')]
        native.sendNativePush.mockResolvedValue(TRANSITORIO)
        consegnato.marcaConsegnati.mockImplementation(consegnaOk(5))

        const e = await eseguiDispatch()

        expect(e.stato).toBe(500)
        expect(righeLog('error', 'query-fallita')).toEqual([
            expect.objectContaining({ consegne_chat: 1, consegne_chat_righe: 5, consegne_chat_saltate: 0 }),
        ])
    })
})
