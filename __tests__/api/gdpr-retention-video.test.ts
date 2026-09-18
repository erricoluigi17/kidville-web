import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// LA CONSERVAZIONE DEGLI ORIGINALI VIDEO — e le cinque cose che i tre gemelli
// (`retention-galleria`, `retention-candidature`, `retention-personale`) hanno
// già pagato al posto nostro.
//
// 1. PRIMA IL FILE, POI LA RIGA — e per riga, non per lotto. Al contrario, un
//    errore a metà lascerebbe il video nel bucket con la riga che lo dichiara già
//    rimosso: irraggiungibile, non cancellato, e nemmeno identificabile per
//    cancellarlo se una famiglia lo chiedesse.
// 2. IL TIMBRO NON È UN `update` DELLA ROUTE. È `video_retention_originale_rimosso`,
//    che rilegge la scadenza sotto lock: fra la lettura dell'elenco e la chiamata
//    allo Storage passano secondi, e in quei secondi la riga può cambiare.
// 3. IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO, dentro un `finally`. Con i soli
//    errori, «nessun log» non distingue «niente da togliere» da «il giro non parte
//    più» — ed è l'ambiguità che ha nascosto per mesi il guasto delle email.
// 4. RIGHE TRATTENUTE ⇒ 500. Un 200 direbbe «fatto» a chi sorveglia, e resterebbero
//    originali di video di minori nell'archivio oltre il termine.
// 5. UN OGGETTO CHE UNA RIGA NOMINA ANCORA NON È UN ORFANO. La spazzata parte dal
//    bucket e chiede al database chi reclama: senza la domanda, cancellerebbe
//    l'originale di un job vivo.
//
// E una sesta, che è di questa consegna e non dei gemelli: **un evento di
// `video_outbox` che nessuno sa consegnare non si dichiara inviato.** La testata di
// `video_outbox_fail` racconta la misura che l'ha scritta — venticinque tentativi
// bruciati in sedici millisecondi — e la conseguenza: l'evento che aggancia il video
// alla sua News non riprovato mai più.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-video-non-usato-altrove'

const JOB_A = '40000000-0000-4000-8000-00000000000a'
const JOB_B = '40000000-0000-4000-8000-00000000000b'
const INTENT = '30000000-0000-4000-8000-000000000003'
const PATH_A = 'originals/40000000-0000-4000-8000-00000000000a/source.mov'
const PATH_B = 'originals/40000000-0000-4000-8000-00000000000b/source.mov'

const h = vi.hoisted(() => ({
    /**
     * LA SEQUENZA REALE DELLE OPERAZIONI: è l'ORDINE la cosa da provare.
     * `remove` → `rpc:video_retention_originale_rimosso`. Un doppio che non
     * registrasse l'ordine renderebbe verde una route che timbra la riga e poi prova
     * a togliere il file — cioè il difetto che tutta la famiglia esiste per impedire.
     */
    sequenza: [] as { tipo: string; valore: unknown }[],
    /** Ogni `rpc()` con i suoi argomenti: le soglie si verificano da qui. */
    rpc: [] as { nome: string; argomenti: Record<string, unknown> }[],
    /** Ogni query con le sue clausole, per poterle asserire PER QUERY. */
    query: [] as {
        ordinale: number
        tabella: string
        operazione: string
        colonne?: string
        opzioni?: unknown
        clausole: { metodo: string; argomenti: unknown[] }[]
    }[],
    nQuery: 0,

    // ── LE RISPOSTE DELLE RPC ──
    scadenze: { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0 } as unknown,
    erroreScadenze: null as unknown,
    timbro: { ok: true } as unknown,
    erroreTimbro: null as unknown,
    /** Fa LANCIARE la RPC del timbro: è l'unico modo di raggiungere il `catch` finale. */
    eccezioneTimbro: null as unknown,
    riconciliazione: {
        ok: true,
        conclusi_senza_scadenza: 0,
        outbox_in_quarantena: 0,
    } as unknown,
    erroreRiconciliazione: null as unknown,
    outboxClaim: { ok: true, eventi: [] as unknown[] } as unknown,
    erroreClaim: null as unknown,
    outboxChiusura: { ok: true } as unknown,

    // ── IL DATABASE ──
    /** Le righe scadute: `id` + `original_path`. */
    scaduti: [] as { id: string; original_path: string }[],
    erroreScaduti: null as unknown,
    /** I percorsi che UNA riga di `video_jobs` reclama ancora. */
    reclamati: [] as string[],
    erroreReclamati: null as unknown,
    /** Quanti job dell'intent sono ancora senza scadenza: > 0 ⇒ ricevuta negata. */
    senzaScadenzaPerIntent: 0,
    erroreRicevuta: null as unknown,

    // ── LO STORAGE ──
    removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
    /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket. */
    ancoraNelBucket: new Set<string>(),
    erroreVerifica: null as unknown,
    /** L'albero del bucket: cartella → voci. `''` è la radice. */
    albero: {} as Record<
        string,
        { name?: string | null; id?: string | null; created_at?: string | null }[]
    >,
    /** Le elencazioni fatte: cartella e opzioni, come le riceve la Storage API. */
    elencazioni: [] as { cartella: string; opzioni: unknown }[],
    erroreElenco: null as unknown,

    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
    staffNegato: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn(async () =>
        h.staffNegato
            ? { user: null, response: h.staffNegato }
            : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
    ),
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        // ⚠️ `rimuoviEVerifica` e `bloccanti` NON sono mockati: arrivano dal modulo
        // vero (`src/lib/storage/rimozione-verificata.ts`). È lì che sta la regola
        // «uscito adesso / non c'è più / c'è ancora / non so», e mockarla renderebbe
        // verde una route che tratta «non so» come «non c'è».
        const builder = (tabella: string) => {
            const ordinale = ++h.nQuery
            const clausole: { metodo: string; argomenti: unknown[] }[] = []
            let versato = false
            const qb: Record<string, unknown> = { __tabella: tabella, __op: 'select' }
            qb.select = (colonne: string, opzioni?: { count?: string; head?: boolean }) => {
                qb.__colonne = colonne
                qb.__opzioni = opzioni
                return qb
            }
            for (const m of ['not', 'is', 'lt', 'lte', 'gt', 'eq', 'order', 'limit']) {
                qb[m] = (...argomenti: unknown[]) => {
                    clausole.push({ metodo: m, argomenti })
                    return qb
                }
            }
            qb.in = (...argomenti: unknown[]) => {
                clausole.push({ metodo: 'in', argomenti })
                qb.__in = argomenti[1]
                return qb
            }
            const versa = () => {
                if (versato) return
                versato = true
                h.query.push({
                    ordinale,
                    tabella,
                    operazione: qb.__op as string,
                    colonne: qb.__colonne as string | undefined,
                    opzioni: qb.__opzioni,
                    clausole,
                })
            }
            qb.then = (res: (v: unknown) => unknown) => {
                versa()
                const colonne = qb.__colonne as string
                const ids = (qb.__in as string[] | undefined) ?? []

                if (colonne === 'id, original_path') {
                    h.sequenza.push({ tipo: 'leggi-scaduti', valore: null })
                    return Promise.resolve({ data: h.scaduti, error: h.erroreScaduti }).then(res)
                }
                if (colonne === 'original_path') {
                    // Il doppio risponde SOLO per i percorsi chiesti, come PostgREST: uno
                    // che restituisse tutti i reclamati a ogni lotto renderebbe verde una
                    // route che sbaglia a spezzare i lotti.
                    const lotto = new Set(ids)
                    return Promise.resolve(
                        h.erroreReclamati
                            ? { data: null, error: h.erroreReclamati }
                            : {
                                  data: h.reclamati
                                      .filter((p) => lotto.has(p))
                                      .map((original_path) => ({ original_path })),
                                  error: null,
                              },
                    ).then(res)
                }
                if (colonne === 'id') {
                    // La ricevuta dell'outbox: un CONTEGGIO, non delle righe.
                    return Promise.resolve({
                        data: null,
                        error: h.erroreRicevuta,
                        count: h.senzaScadenzaPerIntent,
                    }).then(res)
                }
                return Promise.resolve({ data: [], error: null }).then(res)
            }
            return qb
        }

        return {
            from: builder,
            rpc: (nome: string, argomenti: Record<string, unknown>) => {
                h.rpc.push({ nome, argomenti })
                h.sequenza.push({ tipo: `rpc:${nome}`, valore: argomenti })
                if (nome === 'video_retention_scadenze') {
                    return Promise.resolve({ data: h.scadenze, error: h.erroreScadenze })
                }
                if (nome === 'video_retention_originale_rimosso') {
                    if (h.eccezioneTimbro) throw h.eccezioneTimbro
                    return Promise.resolve({ data: h.timbro, error: h.erroreTimbro })
                }
                if (nome === 'video_riconciliazione') {
                    return Promise.resolve({ data: h.riconciliazione, error: h.erroreRiconciliazione })
                }
                if (nome === 'video_outbox_claim') {
                    return Promise.resolve({ data: h.outboxClaim, error: h.erroreClaim })
                }
                return Promise.resolve({ data: h.outboxChiusura, error: null })
            },
            storage: {
                from: () => ({
                    remove: (percorsi: string[]) => {
                        h.sequenza.push({ tipo: 'remove', valore: percorsi })
                        return Promise.resolve(
                            h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
                        )
                    },
                    // ⚠️ `list()` serve DUE scopi, e confonderli è il modo più facile di
                    // rendere verde una spazzata cieca: `rimuoviEVerifica` chiede di UN
                    // percorso passando `search`; la traversata elenca una CARTELLA.
                    list: (cartella: string, opzioni?: { search?: string }) => {
                        if (typeof opzioni?.search === 'string') {
                            const nome = opzioni.search
                            if (h.erroreVerifica) {
                                return Promise.resolve({ data: null, error: h.erroreVerifica })
                            }
                            const completo = cartella ? `${cartella}/${nome}` : nome
                            return Promise.resolve({
                                data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
                                error: null,
                            })
                        }
                        h.elencazioni.push({ cartella, opzioni })
                        if (h.erroreElenco) return Promise.resolve({ data: null, error: h.erroreElenco })
                        return Promise.resolve({ data: h.albero[cartella] ?? [], error: null })
                    },
                }),
            },
        }
    },
}))

import { POST } from '@/app/api/gdpr/retention-video/route'

/** Un istante abbastanza vecchio da superare la grazia di 24 ore. */
const VECCHIO = new Date(Date.now() - 72 * 3_600_000).toISOString()
/** Un istante dentro la grazia: un caricamento che potrebbe essere in corso. */
const GIOVANE = new Date(Date.now() - 3 * 3_600_000).toISOString()

function chiamata(headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) {
    return new Request('http://localhost/api/gdpr/retention-video', {
        method: 'POST',
        headers,
    }) as unknown as Parameters<typeof POST>[0]
}

const battito = () =>
    h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'ms' in e.campi)

beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    h.sequenza = []
    h.rpc = []
    h.query = []
    h.nQuery = 0
    h.scadenze = { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0 }
    h.erroreScadenze = null
    h.timbro = { ok: true }
    h.erroreTimbro = null
    h.eccezioneTimbro = null
    h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0 }
    h.erroreRiconciliazione = null
    h.outboxClaim = { ok: true, eventi: [] }
    h.erroreClaim = null
    h.outboxChiusura = { ok: true }
    h.scaduti = []
    h.erroreScaduti = null
    h.reclamati = []
    h.erroreReclamati = null
    h.senzaScadenzaPerIntent = 0
    h.erroreRicevuta = null
    h.removeRisposta = null
    h.ancoraNelBucket = new Set()
    h.erroreVerifica = null
    h.albero = {}
    h.elencazioni = []
    h.erroreElenco = null
    h.eventi = []
    h.staffNegato = null
})

describe('il gate, e il cron che bussa con la chiave sbagliata', () => {
    it('senza cron secret passa da requireStaff, e se lo staff nega non tocca niente', async () => {
        h.staffNegato = new Response('no', { status: 403 })
        const res = await POST(chiamata({}))

        expect(res.status).toBe(403)
        // Nessuna query, nessuna RPC, nessun file: il gate viene PRIMA di tutto.
        expect(h.rpc).toEqual([])
        expect(h.sequenza).toEqual([])
        expect(battito()[0].campi.esito).toBe('non-autorizzato')
    })

    it('un header presente e sbagliato è un GUASTO e si grida, non si degrada in silenzio', async () => {
        // È il guasto invisibile: il cron smette di conservare e nessuno lo sa,
        // perché dal lato del prodotto non succede niente.
        await POST(chiamata({ 'x-cron-secret': 'chiave-sbagliata' }))
        const grido = h.eventi.find((e) => e.campi.esito === 'secret-errato')
        expect(grido?.livello).toBe('error')
    })

    it('lo staff può lanciare il giro a mano, e il battito dichiara il canale', async () => {
        await POST(chiamata({}))
        expect(battito()[0].campi.canale).toBe('manuale')
    })
})

describe('lo schema video non applicato: si dichiara, non si finge', () => {
    it('PGRST202 sulla prima RPC ⇒ 503 e battito `schema-assente`, non un 200 che dice «niente da fare»', async () => {
        // Il database E2E della CI è un progetto separato e NON migrato, e le quattro
        // migrazioni video sono in `IN_CODA`. Un `200` qui direbbe «non c'era niente
        // da togliere», che è un altro fatto.
        h.erroreScadenze = { code: 'PGRST202', message: 'function not found' }
        const res = await POST(chiamata())

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'schema-assente' })
        expect(battito()[0].campi.esito).toBe('schema-assente')
        // Nessun file toccato: non si spazza un bucket che non esiste.
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
    })

    it('un errore VERO della stessa RPC è un 500, non un 503: i due casi non si confondono', async () => {
        h.erroreScadenze = { code: '57014', message: 'canceled' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(battito()[0].campi.esito).toBe('scadenze-fallite')
    })
})

describe('le scadenze: le soglie applicate sono quelle dichiarate', () => {
    it('chiama `video_retention_scadenze` con 48 ore di upload e 168 di incaglio', async () => {
        await POST(chiamata())
        const chiamataRpc = h.rpc.find((r) => r.nome === 'video_retention_scadenze')
        expect(chiamataRpc?.argomenti).toMatchObject({
            p_ore_upload: 48,
            p_ore_incaglio: 7 * 24,
        })
        // Il tetto del lotto c'è: senza, una coda arretrata terrebbe lock su
        // migliaia di righe dentro una richiesta con un tempo massimo.
        expect(typeof chiamataRpc?.argomenti.p_limite).toBe('number')
    })

    it('è la PRIMA cosa che fa: un originale senza scadenza non comparirebbe nell’elenco', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        await POST(chiamata())

        const iScadenze = h.sequenza.findIndex((s) => s.tipo === 'rpc:video_retention_scadenze')
        const iElenco = h.sequenza.findIndex((s) => s.tipo === 'leggi-scaduti')
        expect(iScadenze).toBeGreaterThanOrEqual(0)
        expect(iScadenze).toBeLessThan(iElenco)
    })

    it('se la RETE ha pescato, lo grida: un cammino nuovo chiude i job senza scadenza', async () => {
        h.scadenze = { ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 3 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'conclusi-senza-scadenza')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.n_righe).toBe(3)
    })

    it('un rifiuto della RPC (argomenti sbagliati) non passa per un giro riuscito', async () => {
        h.scadenze = { ok: false, code: 'BAD_INPUT' }
        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(battito()[0].campi.esito).toBe('scadenze-rifiutate')
    })
})

describe('gli originali scaduti: prima il file, poi la riga', () => {
    it('l’elenco esce dall’indice PARZIALE della retention, e non da una scansione', async () => {
        await POST(chiamata())
        const lettura = h.query.find((q) => q.colonne === 'id, original_path')
        expect(lettura).toBeDefined()

        const metodi = lettura!.clausole.map((c) => `${c.metodo}:${JSON.stringify(c.argomenti)}`)
        // Le tre condizioni dell'indice `video_jobs_retention_originali_idx`, più il
        // bucket. Senza la `lte` sulla scadenza si distruggerebbe l'originale di un
        // video che deve ancora essere convertito.
        expect(metodi).toContain('is:["original_deleted_at",null]')
        expect(metodi).toContain('not:["original_delete_after","is",null]')
        expect(metodi.some((m) => m.startsWith('lte:["original_delete_after"'))).toBe(true)
        expect(metodi).toContain('eq:["original_bucket","video_originals"]')
    })

    it('PRIMA il `remove` sull’archivio, POI il timbro sulla riga', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        await POST(chiamata())

        const iRemove = h.sequenza.findIndex((s) => s.tipo === 'remove')
        const iTimbro = h.sequenza.findIndex(
            (s) => s.tipo === 'rpc:video_retention_originale_rimosso',
        )
        expect(iRemove).toBeGreaterThanOrEqual(0)
        expect(iTimbro).toBeGreaterThan(iRemove)
    })

    it('il timbro passa dalla RPC che rilegge la scadenza, non da un `update` della route', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        await POST(chiamata())

        expect(h.rpc.map((r) => r.nome)).toContain('video_retention_originale_rimosso')
        expect(h.query.filter((q) => q.operazione === 'update')).toEqual([])
        expect(
            h.rpc.find((r) => r.nome === 'video_retention_originale_rimosso')?.argomenti,
        ).toEqual({ p_job_id: JOB_A })
    })

    it('un file che RESTA nel bucket trattiene LA SUA riga, non quelle degli altri', async () => {
        h.scaduti = [
            { id: JOB_A, original_path: PATH_A },
            { id: JOB_B, original_path: PATH_B },
        ]
        // `remove` dice di aver tolto solo B; A risulta ancora nel bucket.
        h.removeRisposta = { data: [{ name: PATH_B }], error: null }
        h.ancoraNelBucket = new Set([PATH_A])

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({
            ok: false,
            motivo: 'file-non-rimossi',
            originali_rimossi: 1,
            originali_trattenuti: 1,
        })
        // B è stato timbrato, A no: il guasto di uno non blocca l'altro.
        const timbrati = h.rpc
            .filter((r) => r.nome === 'video_retention_originale_rimosso')
            .map((r) => r.argomenti.p_job_id)
        expect(timbrati).toEqual([JOB_B])
    })

    it('«non so» vale come «c’è ancora»: una verifica che non risponde trattiene la riga', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.removeRisposta = { data: [], error: null }
        h.erroreVerifica = { code: 'X', message: 'lo storage non risponde' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ motivo: 'verifica-non-riuscita' })
        expect(h.rpc.filter((r) => r.nome === 'video_retention_originale_rimosso')).toEqual([])
    })

    it('un file GIÀ assente NON è un guasto: l’esito voluto era già raggiunto', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.removeRisposta = { data: [], error: null }
        h.ancoraNelBucket = new Set()

        const res = await POST(chiamata())

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ originali_rimossi: 1, originali_gia_assenti: 1 })
    })

    it('il file è uscito ma la RPC rifiuta il timbro: si grida e la riga resta trattenuta', async () => {
        h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
        h.timbro = { ok: false, code: 'NON_ANCORA_SCADUTO' }

        const res = await POST(chiamata())

        expect(res.status).toBe(500)
        const grido = h.eventi.find((e) => e.campi.esito === 'timbro-rifiutato')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.error_code).toBe('NON_ANCORA_SCADUTO')
    })
})

describe('gli orfani del bucket: dal magazzino al database, che è la direzione opposta', () => {
    it('scende nelle CARTELLE (`id: null`) invece di trattarle come oggetti', async () => {
        // Il difetto che la galleria ha pagato: `list()` su un prefisso restituisce
        // le cartelle, non i file. Una traversata che le contasse come oggetti
        // riferirebbe «zero orfani» a ogni giro — verde, e cieca.
        h.albero = {
            '': [{ name: 'originals', id: null }],
            originals: [{ name: JOB_A, id: null }],
            [`originals/${JOB_A}`]: [
                { name: 'source.mov', id: 'oggetto-1', created_at: VECCHIO },
            ],
        }
        const res = await POST(chiamata())
        const corpo = await res.json()

        expect(h.elencazioni.map((e) => e.cartella)).toEqual(['', 'originals', `originals/${JOB_A}`])
        expect(corpo.orfani_esaminati).toBe(1)
        expect(corpo.orfani_rimossi).toBe(1)
    })

    it('un oggetto RECLAMATO da una riga non si tocca, e uno solo va via', async () => {
        h.albero = {
            '': [
                { name: 'reclamato.mov', id: 'o1', created_at: VECCHIO },
                { name: 'orfano.mov', id: 'o2', created_at: VECCHIO },
            ],
        }
        h.reclamati = ['reclamato.mov']

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esaminati: 2, orfani_rimossi: 1 })

        const rimozioni = h.sequenza.filter((s) => s.tipo === 'remove')
        expect(rimozioni).toHaveLength(1)
        expect(rimozioni[0].valore).toEqual(['orfano.mov'])
    })

    it('la GRAZIA di 24 ore protegge un caricamento la cui riga sta ancora nascendo', async () => {
        h.albero = { '': [{ name: 'appena-caricato.mov', id: 'o1', created_at: GIOVANE }] }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esaminati: 0, orfani_rimossi: 0 })
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
    })

    it('una data illeggibile vale come «giovane»: nel dubbio non si distrugge', async () => {
        h.albero = { '': [{ name: 'senza-data.mov', id: 'o1', created_at: null }] }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_rimossi: 0 })
    })

    it('se la domanda «chi lo reclama?» FALLISCE, non si cancella niente', async () => {
        // È il ramo che, senza il controllo sul valore di ritorno di PostgREST,
        // proseguirebbe con «nessuno lo reclama» e distruggerebbe il video di un
        // bambino il cui job è vivo. PostgREST non lancia: ritorna `{ error }`.
        h.albero = { '': [{ name: 'orfano.mov', id: 'o1', created_at: VECCHIO }] }
        h.erroreReclamati = { code: '42P01', message: 'relation does not exist' }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_esito: 'reclami-falliti', orfani_rimossi: 0 })
        expect(h.sequenza.filter((s) => s.tipo === 'remove')).toEqual([])
        expect(h.eventi.find((e) => e.campi.esito === 'orfani-reclami-falliti')?.livello).toBe('error')
    })

    it('una cartella troppo in fondo non viene esplorata, e il fatto si DICHIARA', async () => {
        // Un troncamento silenzioso racconterebbe una pulizia che non è avvenuta.
        h.albero = {
            '': [{ name: 'a', id: null }],
            a: [{ name: 'b', id: null }],
            'a/b': [{ name: 'c', id: null }],
        }
        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ orfani_profondita_troncata: true })
    })
})

describe('la coda delle notifiche: svuotata con le RPC che esistono già', () => {
    const evento = (event_type: string) => ({
        id: '60000000-0000-4000-8000-000000000001',
        intent_id: INTENT,
        revision: 1,
        event_type,
        attempts: 1,
    })

    it('un evento NOTO la cui ricevuta torna si dichiara inviato', async () => {
        h.outboxClaim = { ok: true, eventi: [evento('intent.superseded')] }
        h.senzaScadenzaPerIntent = 0

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ outbox_presi: 1, outbox_inviati: 1 })
        expect(h.rpc.map((r) => r.nome)).toContain('video_outbox_sent')
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_fail')
    })

    it('un evento NOTO i cui job sono ancora senza scadenza NON si dichiara inviato', async () => {
        // La ricevuta è il punto: l'evento dice «questa revisione è morta, la
        // retention deve saperlo». Se quei job sono invisibili all'indice, la
        // retention NON lo sa, e dichiarare l'evento consegnato sarebbe una bugia.
        h.outboxClaim = { ok: true, eventi: [evento('intent.revoked')] }
        h.senzaScadenzaPerIntent = 2

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ outbox_presi: 1, outbox_inviati: 0, outbox_falliti: 1 })
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_sent')
        const fallimento = h.rpc.find((r) => r.nome === 'video_outbox_fail')
        expect(fallimento?.argomenti.p_error_code).toBe('ORIGINALI_SENZA_SCADENZA')
        expect(h.eventi.find((e) => e.campi.esito === 'outbox-originali-senza-scadenza')?.livello).toBe(
            'error',
        )
    })

    it('un evento SENZA destinatario si grida e si rimette in attesa: MAI dichiarato inviato', async () => {
        // È il caso che conta. Dichiararlo inviato lo cancellerebbe dalla coda senza
        // che nessuno l'abbia consegnato; e bruciarlo subito con 25 tentativi in
        // sedici millisecondi è la misura che ha scritto il backoff di
        // `video_outbox_fail`.
        h.outboxClaim = { ok: true, eventi: [evento('intent.published')] }

        const res = await POST(chiamata())
        expect(await res.json()).toMatchObject({ outbox_senza_destinatario: 1, outbox_inviati: 0 })
        expect(h.rpc.map((r) => r.nome)).not.toContain('video_outbox_sent')
        expect(h.rpc.find((r) => r.nome === 'video_outbox_fail')?.argomenti.p_error_code).toBe(
            'DESTINATARIO_ASSENTE',
        )
        const grido = h.eventi.find((e) => e.campi.esito === 'outbox-senza-destinatario')
        // Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
        expect(grido?.livello).toBe('error')
    })

    it('la lease del claim è la STESSA che chiude l’evento, altrimenti il database rifiuta', async () => {
        h.outboxClaim = { ok: true, eventi: [evento('intent.superseded')] }
        await POST(chiamata())

        const claim = h.rpc.find((r) => r.nome === 'video_outbox_claim')
        const sent = h.rpc.find((r) => r.nome === 'video_outbox_sent')
        expect(sent?.argomenti.p_lease_owner).toBe(claim?.argomenti.p_lease_owner)
        expect(typeof claim?.argomenti.p_lease_owner).toBe('string')
    })

    it('lo svuotamento logga anche il SUCCESSO, e a zero: «nessun log» non è «coda vuota»', async () => {
        await POST(chiamata())
        const riga = h.eventi.find((e) => e.campi.esito === 'outbox-svuotato')
        expect(riga?.livello).toBe('info')
        expect(riga?.campi.n_righe).toBe(0)
    })
})

describe('la riconciliazione: i due numeri che devono valere zero', () => {
    it('la quarantena dell’outbox si grida: nessuno riprenderà più quegli eventi', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 0, outbox_in_quarantena: 4 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'outbox-in-quarantena')
        expect(grido?.livello).toBe('error')
        expect(grido?.campi.n_righe).toBe(4)
    })

    it('invisibili RESIDUI dopo la rete: il tetto del lotto non basta, e si dice', async () => {
        h.riconciliazione = { ok: true, conclusi_senza_scadenza: 7, outbox_in_quarantena: 0 }
        await POST(chiamata())

        const grido = h.eventi.find((e) => e.campi.esito === 'invisibili-residui')
        expect(grido?.livello).toBe('error')
    })

    it('il peso morto di `video_processing` finisce NEL BATTITO, non solo nella risposta', async () => {
        // La risposta la legge chi lancia il giro a mano; il battito resta
        // interrogabile in SQL per trenta giorni, ed è l'unico posto da cui si può
        // sapere quanto pesa un buco che questa consegna dichiara e non chiude.
        h.riconciliazione = {
            ok: true,
            conclusi_senza_scadenza: 0,
            outbox_in_quarantena: 0,
            output_di_job_conclusi: 12,
        }
        await POST(chiamata())
        expect(battito()[0].campi.n_output_di_job_conclusi).toBe(12)
    })

    it('i conteggi tornano nella risposta: chi lancia il giro a mano deve poterli leggere', async () => {
        h.riconciliazione = { ok: true, in_coda: 9, conclusi_senza_scadenza: 0, outbox_in_quarantena: 0 }
        const res = await POST(chiamata())
        expect((await res.json()).riconciliazione).toMatchObject({ in_coda: 9 })
    })
})

describe('il battito, e cosa NON esce dai log', () => {
    it('si scrive SEMPRE, anche a zero righe, con `evento: cron` e `esito: ok`', async () => {
        await POST(chiamata())
        const b = battito()
        expect(b).toHaveLength(1)
        expect(b[0].campi).toMatchObject({ operazione: 'video-retention', esito: 'ok', canale: 'cron' })
        expect(b[0].campi.n_originali_rimossi).toBe(0)
    })

    it('si scrive anche quando TUTTO è fallito, perché sta in un `finally`', async () => {
        h.erroreScaduti = { code: '57014', message: 'canceled' }
        await POST(chiamata())
        expect(battito()[0].campi.esito).toBe('lettura-fallita')
    })

    /**
     * ⚠️ QUESTA PROVA VALE QUANTO I RAMI CHE ATTRAVERSA, e la prima stesura ne
     * attraversava troppo pochi.
     *
     * Misurato il 2026-09-18 su questo stesso file: infilando `original_path` nel
     * `msg` del `catch` finale della route, le 33 prove restavano **tutte verdi** —
     * nessuna faceva lanciare niente, quindi quel `logEvento` non veniva mai
     * eseguito e il percorso di un video di un minore sarebbe finito in `app_log`
     * col gate verde. È la forma di difetto che questo repo chiama «un test mai
     * visto fallire non è un test».
     *
     * Perciò i rami si elencano e si percorrono tutti: il percorso felice, il
     * trattenimento, l'orfano non rimosso, e l'eccezione. `it.each` con un fixture
     * per ramo, così aggiungerne uno è una riga e dimenticarsene è visibile.
     */
    const RAMI: { nome: string; prepara: () => void }[] = [
        {
            nome: 'percorso felice (tutto esce, e c’è un orfano)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.albero = {
                    '': [{ name: 'orfano-di-un-bambino.mov', id: 'o1', created_at: VECCHIO }],
                }
                h.outboxClaim = {
                    ok: true,
                    eventi: [
                        { id: 'e1', intent_id: INTENT, revision: 1, event_type: 'x.y', attempts: 1 },
                    ],
                }
            },
        },
        {
            nome: 'riga trattenuta (il file è ancora nel bucket)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.removeRisposta = { data: [], error: null }
                h.ancoraNelBucket = new Set([PATH_A])
            },
        },
        {
            nome: 'orfano che non esce dall’archivio',
            prepara: () => {
                h.albero = {
                    '': [{ name: 'orfano-di-un-bambino.mov', id: 'o1', created_at: VECCHIO }],
                }
                h.removeRisposta = { data: [], error: null }
                h.ancoraNelBucket = new Set(['orfano-di-un-bambino.mov'])
            },
        },
        {
            nome: 'eccezione non prevista (il `catch` finale)',
            prepara: () => {
                h.scaduti = [{ id: JOB_A, original_path: PATH_A }]
                h.eccezioneTimbro = new Error('la RPC è esplosa')
            },
        },
    ]

    it.each(RAMI)(
        'NESSUN percorso e NESSUN nome di file finisce in un log — ramo: $nome',
        async ({ prepara }) => {
            // Il percorso dentro `video_originals` è la chiave con cui si firma il
            // video di un bambino in un bucket privato: è una credenziale. `app_log`
            // è interrogabile in SQL per trenta giorni.
            prepara()
            await POST(chiamata()).catch(() => {
                // Il ramo dell'eccezione RILANCIA di proposito, perché `withRoute`
                // veda il guasto. Qui interessa solo ciò che è finito nei log, e
                // ingoiare l'eccezione dopo averlo dichiarato non nasconde niente:
                // le asserzioni sono tutte sotto.
            })

            expect(h.eventi.length, 'nessun log emesso: questo ramo non prova niente').toBeGreaterThan(0)
            const testo = JSON.stringify(h.eventi)
            expect(testo).not.toContain(PATH_A)
            expect(testo).not.toContain('source.mov')
            expect(testo).not.toContain('orfano-di-un-bambino')
        },
    )
})
