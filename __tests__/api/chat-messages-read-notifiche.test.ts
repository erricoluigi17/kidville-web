import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * LEGGERE LA CONVERSAZIONE SPEGNE LE SUE NOTIFICHE — LATO SERVER.
 *
 * Prima di questo passo il mark-read toccava solo `chat_messages.read_at`: la riga in
 * `notifiche` restava accesa per sempre. La regola («un messaggio letto spegne le notifiche
 * di tutto quel thread, per chi legge»), la misura che l'ha aperta e il limite noto stanno
 * nella testata di `src/lib/chat/notifiche-chat.ts`: qui non si ripetono, così c'è un posto
 * solo da aggiornare quando si rimisura.
 *
 * Qui NON si mocka `@/lib/chat/notifiche-chat`: gira il modulo vero su un database finto,
 * così il test vede i FILTRI davvero spediti (tabella, utente, tipi, entità) e non solo
 * che «una funzione è stata chiamata» — un mock piatto sarebbe verde con e senza la
 * correzione. `marcaConsegnati` invece resta mockato: la consegna non è l'oggetto di
 * questo file, e sul DB E2E la sua colonna non esiste.
 */

// UUID validi (formato 8-4-4-4-12, versione 4, variante 8). Nessun uuid di produzione.
const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const ESTRANEO = 'cccccccc-0000-4000-8000-000000000003'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const THREAD_2 = 'dddddddd-0000-4000-8000-000000000005'
const THREAD_ALTRUI = 'dddddddd-0000-4000-8000-000000000099'
const M1 = 'eeeeeeee-0000-4000-8000-000000000011'
const M2 = 'eeeeeeee-0000-4000-8000-000000000012'
const M3 = 'eeeeeeee-0000-4000-8000-000000000013'

interface Scrittura {
    tabella: string
    riga: Record<string, unknown>
    filtri: Record<string, unknown>
    select: string | null
}

const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    marcaConsegnati: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    /** Il thread singolo letto dalla GET (`maybeSingle`). */
    thread: null as Record<string, unknown> | null,
    /** I messaggi della lista (GET `.range`). */
    messages: [] as Array<Record<string, unknown>>,
    /** `{id, thread_id}` per la PATCH. */
    msgs: [] as Array<Record<string, unknown>>,
    /** `{id, teacher_id, parent_id}` per la PATCH. */
    threadRows: [] as Array<Record<string, unknown>>,
    /** Ogni UPDATE eseguito, di qualunque tabella: la prova che `notifiche` è (o non è) toccata. */
    scritture: [] as Scrittura[],
    /** Esito dell'UPDATE di `read_at` su `chat_messages`. */
    esitoRead: { error: null } as { error: unknown },
    /** Esito dell'UPDATE su `notifiche` (con `.select('id')`: `data` sono le righe spente). */
    esitoNotifiche: { data: [] as Array<{ id: string }> | null, error: null as unknown },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(), nomeUtente: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: h.logEvento,
    logErrore: h.logErrore,
}))

// ─────────────────────────────────────────────────────────────────────────────
// Client Supabase finto. Le SELECT servono a far arrivare la route al mark-read; gli
// UPDATE sono quelli che il test misura, e ognuno registra la propria catena di filtri.
// PostgREST NON lancia: l'esito è sempre un valore di ritorno.
// ─────────────────────────────────────────────────────────────────────────────
const adminClient = {
    from(tabella: string) {
        const b: Record<string, unknown> = {}
        const filtriSelect: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.eq = (col: string, val: unknown) => { filtriSelect[col] = val; return b }
        b.in = (col: string, val: unknown) => { filtriSelect[col] = val; return b }
        b.is = (col: string, val: unknown) => { filtriSelect[col] = val; return b }
        b.maybeSingle = async () => {
            if (tabella === 'chat_threads') return { data: h.thread, error: null }
            return { data: null, error: null }
        }
        b.range = async () => ({ data: h.messages, count: h.messages.length, error: null })
        b.update = (riga: Record<string, unknown>) => {
            const s: Scrittura = { tabella, riga, filtri: {}, select: null }
            h.scritture.push(s)
            const esito = () => (tabella === 'notifiche' ? h.esitoNotifiche : h.esitoRead)
            const ub: Record<string, unknown> = {
                eq(col: string, val: unknown) { s.filtri[col] = val; return ub },
                neq(col: string, val: unknown) { s.filtri[`neq:${col}`] = val; return ub },
                is(col: string, val: unknown) { s.filtri[`is:${col}`] = val; return ub },
                in(col: string, val: unknown) { s.filtri[col] = val; return ub },
                select(cols: string) { s.select = cols; return Promise.resolve(esito()) },
                then(res: (v: unknown) => void) { res(esito()) },
            }
            return ub
        }
        b.then = (res: (v: unknown) => void) => {
            if (tabella === 'chat_messages') return res({ data: h.msgs, error: null })
            if (tabella === 'chat_threads') return res({ data: h.threadRows, error: null })
            return res({ data: [], error: null })
        }
        return b
    },
}

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => adminClient,
}))

import { GET } from '@/app/api/chat/messages/route'
import { PATCH } from '@/app/api/chat/messages/read/route'
import { TIPI_NOTIFICA_CHAT, ENTITA_CHAT_THREAD } from '@/lib/chat/notifiche-chat'

const patchReq = (body: unknown) =>
    new Request('http://localhost/api/chat/messages/read', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
const getReq = (qs: string) => new Request(`http://localhost/api/chat/messages?${qs}`)

const suNotifiche = () => h.scritture.filter((s) => s.tabella === 'notifiche')
const righe = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n-${i}` }))

beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: 'sc-1' } })
    h.marcaConsegnati.mockResolvedValue(undefined)
    h.thread = { teacher_id: TEACHER, parent_id: PARENT }
    h.messages = [{ id: M1, thread_id: THREAD, sender_id: PARENT, content: 'ciao', read_at: null }]
    h.msgs = [{ id: M1, thread_id: THREAD }]
    h.threadRows = [{ id: THREAD, teacher_id: TEACHER, parent_id: PARENT }]
    h.scritture = []
    h.esitoRead = { error: null }
    h.esitoNotifiche = { data: righe(1), error: null }
})

describe('PATCH /api/chat/messages/read — spegne le notifiche dei thread letti', () => {
    it('dopo il mark-read spegne le notifiche di chat di QUEL thread, per l\'utente del gate', async () => {
        const res = await PATCH(patchReq({ messageIds: [M1] }))

        expect(res.status).toBe(200)
        const n = suNotifiche()
        expect(n, 'nessun UPDATE su `notifiche`: la campanella resta accesa').toHaveLength(1)
        expect(Object.keys(n[0].riga)).toEqual(['letta_il'])
        // ESATTI, non «contiene»: un filtro in più restringe l'UPDATE senza dirlo.
        expect(n[0].filtri).toEqual({
            utente_id: TEACHER,
            tipo: [...TIPI_NOTIFICA_CHAT],
            entita_tipo: ENTITA_CHAT_THREAD,
            entita_id: [THREAD],
            'is:letta_il': null,
        })
        expect(n[0].select).toBe('id')
    })

    it('risponde con `notifiche_lette`: il numero che dice se il collegamento funziona', async () => {
        h.esitoNotifiche = { data: righe(3), error: null }

        const res = await PATCH(patchReq({ messageIds: [M1] }))
        const j = await res.json()

        expect(j).toMatchObject({ success: true, updated: 1, notifiche_lette: 3 })
    })

    it('solo i thread dei messaggi AMMESSI: quello altrui non finisce nel filtro', async () => {
        // Due messaggi in due thread: uno è dell'utente, l'altro no (anti-IDOR già in essere).
        h.msgs = [{ id: M1, thread_id: THREAD }, { id: M2, thread_id: THREAD_ALTRUI }]
        h.threadRows = [
            { id: THREAD, teacher_id: TEACHER, parent_id: PARENT },
            { id: THREAD_ALTRUI, teacher_id: ESTRANEO, parent_id: ESTRANEO },
        ]

        const res = await PATCH(patchReq({ messageIds: [M1, M2] }))

        expect((await res.json()).updated).toBe(1)
        expect(suNotifiche()[0].filtri.entita_id, 'spento un thread di cui l\'utente non è parte').toEqual([THREAD])
    })

    it('due thread propri: entrambi nello stesso filtro, una query sola', async () => {
        h.msgs = [
            { id: M1, thread_id: THREAD },
            { id: M2, thread_id: THREAD },
            { id: M3, thread_id: THREAD_2 },
        ]
        h.threadRows = [
            { id: THREAD, teacher_id: TEACHER, parent_id: PARENT },
            { id: THREAD_2, teacher_id: TEACHER, parent_id: PARENT },
        ]

        await PATCH(patchReq({ messageIds: [M1, M2, M3] }))

        expect(suNotifiche()).toHaveLength(1)
        expect(suNotifiche()[0].filtri.entita_id).toEqual([THREAD, THREAD_2])
    })

    it('nessun messaggio ammesso: `notifiche_lette: 0` e NESSUN UPDATE su notifiche', async () => {
        h.msgs = [{ id: M1, thread_id: THREAD_ALTRUI }]
        h.threadRows = [{ id: THREAD_ALTRUI, teacher_id: ESTRANEO, parent_id: ESTRANEO }]

        const res = await PATCH(patchReq({ messageIds: [M1] }))
        const j = await res.json()

        expect(res.status).toBe(200)
        // La forma della risposta è la STESSA del ramo normale: il client non deve
        // distinguere due contratti per lo stesso 200.
        expect(j).toMatchObject({ success: true, updated: 0, notifiche_lette: 0 })
        expect(suNotifiche()).toHaveLength(0)
    })

    it('se l\'UPDATE di `read_at` fallisce → 500 e le notifiche NON si toccano', async () => {
        h.esitoRead = { error: { code: '42P01', message: 'boom' } }

        const res = await PATCH(patchReq({ messageIds: [M1] }))

        expect(res.status).toBe(500)
        // La campanella segue la lettura REGISTRATA: se `read_at` non è stato scritto, per il
        // database quei messaggi non sono letti e la notifica resta coerente con loro.
        expect(suNotifiche(), 'campanella spenta su un mark-read fallito').toHaveLength(0)
    })

    it('se lo SPEGNIMENTO fallisce la risposta resta 200 (il mark-read è già riuscito)', async () => {
        h.esitoNotifiche = { data: null, error: { code: 'PGRST301', message: 'giù' } }

        const res = await PATCH(patchReq({ messageIds: [M1] }))
        const j = await res.json()

        expect(res.status).toBe(200)
        expect(j).toMatchObject({ success: true, updated: 1, notifiche_lette: 0 })
        // Il guasto non è muto: `warn` sul canale `notifica`, persistito per livello.
        expect(h.logEvento).toHaveBeenCalledWith(
            'notifica',
            'warn',
            expect.objectContaining({
                operazione: 'chat/messages/read:PATCH',
                esito: 'notifiche-chat-non-segnate-lette',
            }),
            expect.anything(),
        )
    })

    it('401 anonimo: nessun UPDATE, né sui messaggi né sulle notifiche', async () => {
        h.requireUser.mockResolvedValue({
            response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
        })

        const res = await PATCH(patchReq({ messageIds: [M1] }))

        expect(res.status).toBe(401)
        expect(h.scritture).toHaveLength(0)
    })
})

describe('GET /api/chat/messages?markRead — spegne le notifiche del thread aperto', () => {
    it('spegne le notifiche di chat del thread, con l\'utente del GATE (mai il valore di markRead)', async () => {
        h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore' } })

        const res = await GET(getReq(`threadId=${THREAD}&markRead=${ESTRANEO}`))

        expect(res.status).toBe(200)
        const n = suNotifiche()
        expect(n).toHaveLength(1)
        // ESATTI anche qui: la GET e la PATCH devono spedire la stessa query, non due
        // varianti che divergono in silenzio.
        expect(n[0].filtri).toEqual({
            utente_id: PARENT,
            tipo: [...TIPI_NOTIFICA_CHAT],
            entita_tipo: ENTITA_CHAT_THREAD,
            entita_id: [THREAD],
            'is:letta_il': null,
        })
        expect(n[0].select).toBe('id')
    })

    it('senza `markRead` non si spegne niente: la GET è una lettura, non un mark-read', async () => {
        const res = await GET(getReq(`threadId=${THREAD}`))

        expect(res.status).toBe(200)
        expect(suNotifiche()).toHaveLength(0)
    })

    it('se il mark-read fallisce (`readErr`) le notifiche NON si toccano', async () => {
        h.esitoRead = { error: { code: '42703', message: 'no read_at' } }

        const res = await GET(getReq(`threadId=${THREAD}&markRead=${TEACHER}`))

        // La GET resta 200 (il mark-read è accessorio alla lettura), ma la campanella segue
        // la lettura REGISTRATA: senza `read_at` scritto, la notifica resta accesa.
        expect(res.status).toBe(200)
        expect(suNotifiche()).toHaveLength(0)
    })

    it('403 non partecipante: nessuno spegnimento (IDOR sulla campanella altrui)', async () => {
        h.requireUser.mockResolvedValue({ user: { id: ESTRANEO, role: 'genitore' } })

        const res = await GET(getReq(`threadId=${THREAD}&markRead=${ESTRANEO}`))

        expect(res.status).toBe(403)
        expect(h.scritture).toHaveLength(0)
    })

    it('la forma della risposta della GET non cambia (messages, total, precedenti)', async () => {
        const res = await GET(getReq(`threadId=${THREAD}&markRead=${TEACHER}`))
        const j = await res.json() as Record<string, unknown>

        expect(Object.keys(j).sort()).toEqual(['messages', 'precedenti', 'total'])
        expect(j.total).toBe(1)
    })
})
