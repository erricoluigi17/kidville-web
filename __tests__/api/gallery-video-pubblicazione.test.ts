import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// V08 · `POST /api/gallery` pubblica un VIDEO già convertito — e i due cancelli
// restano due.
//
// ─── CHE COSA DIMOSTRA QUESTO FILE ───────────────────────────────────────────
//
// Il criterio d'accettazione del piano è uno e preciso: **consenso revocato fra
// la conferma e la pubblicazione ⇒ 422, e nessun file resta in `gallery`**. Qui
// si misura letteralmente quello, e si misura in due modi diversi, perché sono
// due guasti diversi:
//
//  1. il consenso è già revocato quando arriva la richiesta di pubblicare: il
//     cancello APPLICATIVO (`alunniSenzaConsenso`) rifiuta con 422 **prima** che
//     lo Storage venga toccato. Non c'è niente da ripulire perché non è stato
//     copiato niente — ed è l'unico ordine in cui questa proprietà è vera per
//     costruzione invece che per compensazione;
//  2. qualcosa cambia sotto, e il cancello TRANSAZIONALE
//     (`video_intent_finalize`) rifiuta **dopo** la copia: allora il file copiato
//     esce da `gallery` e la riga appena nata sparisce. Lo Storage non sta nella
//     transazione, quindi l'unica garanzia possibile è la compensazione — ed è la
//     stessa già provata per le News (`riportaMediaInBozza`).
//
// ─── PERCHÉ NON C'È UNA ROTTA NUOVA ──────────────────────────────────────────
//
// I gate della Galleria — ruolo, sede dichiarata, tag nel perimetro, liberatoria
// fotografica — vivono già dentro questo handler. Una seconda porta significa una
// seconda copia di quelle quattro regole, e in questo repository la seconda copia
// è già costata: il gate dei tag scritto dentro la POST lasciò scoperta la PATCH
// per tre giorni. Qui il ramo video entra DOPO gli stessi gate, non accanto.
// =============================================================================

const SEDE = SEDE_A
const DOCENTE = '22222222-2222-4222-8222-222222222222'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const INTENT = 'e1e1e1e1-1111-4111-8111-eeeeeeeeeeee'
const JOB = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const MEDIA = 'd1d1d1d1-1111-4111-8111-dddddddddddd'
const USCITA = 'lavorazione/e1e1e1e1/1/out.mp4'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

type RigaIntento = Record<string, unknown> | null
type RigaJob = Record<string, unknown>

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    requireParentOfStudent: vi.fn(),
    genitoreHasFiglio: vi.fn(),
    resolveScuolaScrittura: vi.fn(),
    resolveScuoleAttive: vi.fn(),
    scuoleDiUtente: vi.fn(),
    alunniSenzaConsenso: vi.fn(),
    degradoSedeLecito: vi.fn(),
    notificaEvento: vi.fn(),
    genitoriDiAlunni: vi.fn(),
    genitoriDiClassi: vi.fn(),
    genitoriDiScuola: vi.fn(),
    // ─ lo stato del finto database e del finto Storage ─
    intento: null as RigaIntento,
    job: [] as RigaJob[],
    erroreIntento: null as { code?: string } | null,
    erroreJob: null as { code?: string } | null,
    insertRecord: [] as Array<Record<string, unknown>>,
    insertEsiti: [] as Array<{ data: unknown; error: unknown }>,
    deleteIds: [] as string[],
    deleteFiltri: [] as Array<Record<string, string>>,
    deleteErrore: null as { code?: string } | null,
    rpcChiamate: [] as Array<{ nome: string; args: Record<string, unknown> }>,
    rpcEsiti: [] as Array<{ data: unknown; error: unknown }>,
    copie: [] as Array<{ bucket: string; da: string; a: string; opzioni: unknown }>,
    copiaErrore: null as unknown,
    rimozioni: [] as string[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente, requireStaff: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/auth/scope', () => ({
    resolveScuolaScrittura: h.resolveScuolaScrittura,
    resolveScuoleAttive: h.resolveScuoleAttive,
    scuoleDiUtente: h.scuoleDiUtente,
}))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: h.alunniSenzaConsenso }))
vi.mock('@/lib/forms/degrado-sede', () => ({
    degradoSedeLecito: h.degradoSedeLecito,
    colonnaSedeAssente: (e: { code?: string } | null | undefined) =>
        ['PGRST204', '42703'].includes(e?.code ?? ''),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
    genitoriDiAlunni: h.genitoriDiAlunni,
    genitoriDiClassi: h.genitoriDiClassi,
    genitoriDiScuola: h.genitoriDiScuola,
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => ({
        rpc(nome: string, args: Record<string, unknown>) {
            h.rpcChiamate.push({ nome, args })
            return Promise.resolve(h.rpcEsiti.shift() ?? { data: { ok: true }, error: null })
        },
        storage: {
            from(bucket: string) {
                return {
                    copy: async (da: string, a: string, opzioni: unknown) => {
                        h.copie.push({ bucket, da, a, opzioni })
                        if (h.copiaErrore) return { data: null, error: h.copiaErrore }
                        return { data: { path: a }, error: null }
                    },
                    remove: async (percorsi: string[]) => {
                        h.rimozioni.push(percorsi)
                        return { data: percorsi.map((name) => ({ name })), error: null }
                    },
                    list: async () => ({ data: [], error: null }),
                }
            },
        },
        from(tabella: string) {
            // `alunni`: il gate dei tag (`assertTagStudentsInScope`) resta REALE.
            // Mockarlo vorrebbe dire misurare il mock proprio sul presidio che in
            // questo repo è già stato aggirato una volta.
            if (tabella === 'alunni') {
                const q: Record<string, unknown> = {}
                q.select = () => q
                q.in = (colonna: string, valori: string[]) => {
                    if (colonna === 'scuola_id') {
                        return Promise.resolve({
                            data: valori.includes(SEDE)
                                ? [{ id: ALU_1, stato: 'attivo' }, { id: ALU_2, stato: 'attivo' }]
                                : [],
                            error: null,
                        })
                    }
                    return q
                }
                return q
            }
            if (tabella === 'video_intents') {
                const q: Record<string, unknown> = {}
                q.select = () => q
                q.eq = () => q
                q.maybeSingle = async () => ({ data: h.intento, error: h.erroreIntento })
                return q
            }
            if (tabella === 'video_jobs') {
                const q: Record<string, unknown> = {}
                q.select = () => q
                let n = 0
                q.eq = () => {
                    n++
                    // Il secondo `.eq` (la sede) chiude la catena: è una lettura
                    // d'elenco, senza `single`.
                    if (n >= 2) {
                        return Promise.resolve({ data: h.job, error: h.erroreJob })
                    }
                    return q
                }
                return q
            }
            if (tabella !== 'galleria_media_v2') {
                throw new Error(`tabella non prevista da questo test: "${tabella}"`)
            }
            return {
                insert(record: Record<string, unknown>) {
                    h.insertRecord.push({ ...record })
                    const esito = h.insertEsiti.shift() ?? { data: { id: MEDIA, ...record }, error: null }
                    return { select: () => ({ single: async () => esito }) }
                },
                delete() {
                    // `.eq('id', …).eq('scuola_id', …)` — due filtri in AND, e il
                    // secondo non è decorativo: senza, la compensazione sarebbe una
                    // cancellazione per solo identificatore su una tabella che
                    // contiene tre plessi di foto di bambini.
                    const filtri: Record<string, string> = {}
                    const q: Record<string, unknown> = {}
                    q.eq = (colonna: string, valore: string) => {
                        filtri[colonna] = valore
                        if (colonna === 'scuola_id') {
                            h.deleteFiltri.push({ ...filtri })
                            h.deleteIds.push(filtri.id)
                            return Promise.resolve({ data: null, error: h.deleteErrore })
                        }
                        return q
                    }
                    return q
                },
            }
        },
    }),
}))

import { POST } from '@/app/api/gallery/route'

const post = (body: unknown) =>
    new NextRequest('http://localhost/api/gallery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

const corpoVideo = (extra: Record<string, unknown> = {}) => ({
    video_intent_id: INTENT,
    video_revisione: 1,
    scuola_id: SEDE,
    caption: 'La recita',
    tag_students: [ALU_1, ALU_2],
    ...extra,
})

const eventiGalleria = () => log.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

beforeEach(() => {
    vi.clearAllMocks()
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
    h.alunniSenzaConsenso.mockResolvedValue([])
    h.notificaEvento.mockResolvedValue(undefined)
    h.genitoriDiAlunni.mockResolvedValue(['g1', 'g2'])
    h.genitoriDiClassi.mockResolvedValue([])
    h.genitoriDiScuola.mockResolvedValue([])
    h.degradoSedeLecito.mockResolvedValue(true)
    h.intento = {
        id: INTENT,
        owner_id: DOCENTE,
        scuola_id: SEDE,
        channel: 'gallery',
        revision: 1,
        status: 'confirmed',
    }
    h.job = [
        {
            id: JOB,
            status: 'ready',
            verified_at: '2026-09-18T10:00:00Z',
            output_bucket: 'video_processing',
            output_path: USCITA,
            output_size: 12_345_678,
        },
    ]
    h.erroreIntento = null
    h.erroreJob = null
    h.insertRecord = []
    h.insertEsiti = []
    h.deleteIds = []
    h.deleteFiltri = []
    h.deleteErrore = null
    h.rpcChiamate = []
    h.rpcEsiti = []
    h.copie = []
    h.copiaErrore = null
    h.rimozioni = []
})

describe('IL CRITERIO · consenso revocato fra la conferma e la pubblicazione', () => {
    it('risponde 422 e NON copia niente dentro `gallery`', async () => {
        // La famiglia ha revocato la liberatoria dopo che l'insegnante aveva già
        // confermato l'intento: il video è pronto, convertito, verificato — e non
        // si pubblica.
        h.alunniSenzaConsenso.mockResolvedValue([{ id: ALU_2, nome: 'Bea' }])

        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(422)

        // Le tre metà della promessa «nessun file resta in `gallery`»:
        expect(h.copie, 'nessuna copia deve essere partita').toEqual([])
        expect(h.insertRecord, 'nessuna riga di galleria deve essere nata').toEqual([])
        expect(h.rpcChiamate, 'la RPC non deve nemmeno essere interpellata').toEqual([])
        // E non c'è niente da compensare, perché non è stato fatto niente.
        expect(h.rimozioni).toEqual([])
    })

    it('il rifiuto non nomina i bambini nel LOG (solo conteggi)', async () => {
        h.alunniSenzaConsenso.mockResolvedValue([{ id: ALU_2, nome: 'Bea' }])
        await POST(post(corpoVideo()))
        const riga = eventiGalleria().find((c) => c[2]?.esito === 'liberatoria-mancante')
        expect(riga).toBeTruthy()
        expect(JSON.stringify(riga?.[2])).not.toContain('Bea')
        expect(JSON.stringify(riga?.[2])).not.toContain(ALU_2)
    })
})

describe('il percorso felice — copia, riga, RPC, nello stesso ordine', () => {
    it('copia l’uscita in `gallery` e salva il PERCORSO, con `file_type: video`', async () => {
        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(201)

        expect(h.copie).toHaveLength(1)
        expect(h.copie[0].bucket).toBe('video_processing')
        expect(h.copie[0].da).toBe(USCITA)
        expect(h.copie[0].opzioni).toEqual({ destinationBucket: 'gallery' })

        expect(h.insertRecord).toHaveLength(1)
        const riga = h.insertRecord[0]
        expect(riga.file_type).toBe('video')
        expect(riga.scuola_id).toBe(SEDE)
        // In tabella il PERCORSO, mai un indirizzo firmato: quello scade.
        expect(String(riga.file_url)).toBe(h.copie[0].a)
        expect(String(riga.file_url)).toMatch(new RegExp(`^uploads/${DOCENTE}/`))
    })

    it('chiama `video_intent_finalize` nella STESSA richiesta, con lo scope appena risolto', async () => {
        await POST(post(corpoVideo()))
        expect(h.rpcChiamate).toHaveLength(1)
        const { nome, args } = h.rpcChiamate[0]
        expect(nome).toBe('video_intent_finalize')
        expect(args.p_intent_id).toBe(INTENT)
        expect(args.p_owner_id).toBe(DOCENTE)
        expect(args.p_revision).toBe(1)
        expect(args.p_channel).toBe('gallery')
        // LA SEDE È QUELLA RISOLTA DA `resolveScuolaScrittura`, non quella letta
        // dall'intento: è il confronto che la RPC fa (`SCOPE_CHANGED`), e
        // passargli la sede dell'intento lo renderebbe un confronto con sé stesso.
        expect(args.p_scuola_id).toBe(SEDE)
        expect(args.p_target_id).toBe(MEDIA)
        // Il payload dell'outbox non porta dati personali: uuid e numeri.
        expect(JSON.stringify(args.p_payload)).not.toContain('La recita')
    })

    it('la riga di successo dice che è un video, e la notifica parte', async () => {
        await POST(post(corpoVideo()))
        const riga = eventiGalleria().find((c) => c[2]?.esito === 'pubblicata')
        expect(riga?.[2]?.sede_id).toBe(SEDE)
        expect(riga?.[2]?.video).toBe(true)
        expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    })
})

describe('la RPC rifiuta DOPO la copia — e il file non resta in `gallery`', () => {
    it('toglie il file copiato e cancella la riga appena nata', async () => {
        // L'intento è stato ritirato da un'altra richiesta un istante prima: è
        // esattamente il caso per cui il cancello transazionale esiste.
        h.rpcEsiti = [{ data: { ok: false, code: 'INTENT_REVOKED' }, error: null }]

        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(409)

        expect(h.copie, 'la copia era già partita').toHaveLength(1)
        expect(h.deleteIds, 'la riga appena nata va tolta').toEqual([MEDIA])
        expect(
            h.deleteFiltri,
            'la cancellazione dichiara la sede: un id da solo cancellerebbe per identificatore su tre plessi',
        ).toEqual([{ id: MEDIA, scuola_id: SEDE }])
        expect(h.rimozioni, 'e il file copiato pure').toEqual([[h.copie[0].a]])
        // Nessuna famiglia deve essere avvisata di un video che non c'è.
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('se nemmeno la riga si riesce a cancellare, il file NON si tocca e si grida', async () => {
        h.rpcEsiti = [{ data: { ok: false, code: 'SCOPE_CHANGED' }, error: null }]
        h.deleteErrore = { code: '55000' }

        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(409)
        // Togliere il file lasciando la riga vorrebbe dire una foto rotta in
        // galleria: fra i due mali si sceglie quello recuperabile.
        expect(h.rimozioni).toEqual([])
        const grido = eventiGalleria().find((c) => c[2]?.esito === 'video-riga-non-annullata')
        expect(grido?.[1]).toBe('error')
    })
})

describe('il cancello applicativo, prima di qualunque byte', () => {
    it('intento di un’altra sede: 404 e nessuna copia', async () => {
        // La lettura filtra per sede: una sede diversa non trova nessuna riga.
        h.intento = null
        const res = await POST(post(corpoVideo({ scuola_id: SEDE })))
        expect(res.status).toBe(404)
        expect(h.copie).toEqual([])
    })

    it('intento non ancora confermato: 409 e nessuna copia', async () => {
        h.intento = { ...(h.intento as Record<string, unknown>), status: 'pending' }
        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(409)
        expect(h.copie).toEqual([])
    })

    it('revisione sorpassata: 409 e nessuna copia', async () => {
        const res = await POST(post(corpoVideo({ video_revisione: 2 })))
        expect(res.status).toBe(409)
        expect(h.copie).toEqual([])
    })

    it('job non ancora verificato: 409 e nessuna copia', async () => {
        h.job = [{ ...h.job[0], verified_at: null }]
        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(409)
        expect(h.copie).toEqual([])
    })

    it('un’uscita oltre il tetto: 422, e il tetto non si salta se il byte arriva come STRINGA', async () => {
        // `video_jobs.output_size` è un `bigint`. PostgREST oggi lo serializza come
        // numero, ma un `numeric`, una vista, un `select` con un cast o una versione
        // diversa lo consegnerebbero come stringa — e un controllo scritto
        // `typeof === 'number'` non diventerebbe rosso: **salterebbe in silenzio**,
        // che è il modo in cui una guardia smette di esistere senza che nessuno se
        // ne accorga. Il rifiuto deve arrivare comunque, e prima della copia.
        h.job = [{ ...h.job[0], output_size: '2000000001' }]
        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(422)
        expect(h.copie, 'il tetto si guarda PRIMA di spedire i byte').toEqual([])
    })

    it('la pipeline non è installata su questo impianto: 503, non 500', async () => {
        // Il DB E2E della CI non è migrato: `video_intents` non esiste.
        h.erroreIntento = { code: '42P01' }
        const res = await POST(post(corpoVideo()))
        expect(res.status).toBe(503)
        expect(h.copie).toEqual([])
    })
})

describe('il contratto del corpo', () => {
    it('`video_intent_id` senza revisione è un 400 di validazione', async () => {
        const res = await POST(post({ video_intent_id: INTENT, scuola_id: SEDE }))
        expect(res.status).toBe(400)
        expect(h.copie).toEqual([])
    })

    it('`video_intent_id` INSIEME a `file_url` è un 400: la sorgente dev’essere una sola', async () => {
        const res = await POST(post(corpoVideo({ file_url: 'uploads/x/y.mp4' })))
        expect(res.status).toBe(400)
    })

    it('senza `video_intent_id` il `file_url` resta obbligatorio (regressione)', async () => {
        const res = await POST(post({ scuola_id: SEDE, caption: 'niente file' }))
        expect(res.status).toBe(400)
    })
})

describe('la pubblicazione di una FOTO non cambia di una riga', () => {
    it('nessuna copia, nessuna RPC, stessa riga di prima', async () => {
        const res = await POST(
            post({ file_url: 'uploads/ed1/1.jpg', file_type: 'foto', scuola_id: SEDE, tag_students: [ALU_1] }),
        )
        expect(res.status).toBe(201)
        expect(h.copie).toEqual([])
        expect(h.rpcChiamate).toEqual([])
        expect(h.insertRecord[0].file_url).toBe('uploads/ed1/1.jpg')
        expect(h.insertRecord[0].file_type).toBe('foto')
    })

    it('e la sede sbagliata resta un rifiuto anche col ramo video in mezzo', async () => {
        h.resolveScuolaScrittura.mockResolvedValue({
            response: new Response(null, { status: 400 }),
        })
        const res = await POST(post(corpoVideo({ scuola_id: SEDE_B })))
        expect(res.status).toBe(400)
        expect(h.copie).toEqual([])
    })
})
