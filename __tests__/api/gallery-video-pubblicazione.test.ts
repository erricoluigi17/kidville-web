import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import itShared from '../../messages/it/shared.json'

// =============================================================================
// `POST /api/gallery` NON PUBBLICA PIÙ VIDEO (PR 2 video, 2026-10-02).
//
// ─── CHE COSA ERA ───────────────────────────────────────────────────────────
// Dal 2026-09-18 questa rotta concludeva un impegno della pipeline video: con
// `video_intent_id` + `video_revisione` al posto di `file_url` copiava l'uscita
// convertita dentro `gallery`, scriveva la riga e chiamava `video_intent_finalize`
// nella stessa richiesta, compensando a mano (riga e file) se la RPC rifiutava. Il
// criterio d'accettazione di allora era «consenso revocato fra la conferma e la
// pubblicazione ⇒ 422, e nessun file resta in `gallery`».
//
// ─── CHE COSA È ADESSO, E PERCHÉ IL CRITERIO È CAMBIATO ──────────────────────
// 1. I bambini si scelgono PRIMA dell'invio (`POST /api/video-uploads`), che
//    attraversa gli stessi quattro cancelli (`@/lib/gallery/cancelli-destinatari`):
//    il 422 con i nomi si prende lì, subito, e non quando il video è pronto.
// 2. La pubblicazione la fa il server da solo, appena la conversione finisce
//    (RPC `video_galleria_pubblica`: riga e chiusura dell'intento nella stessa
//    transazione, quindi nessuna compensazione). Decisione del titolare: se la
//    liberatoria viene tolta fra l'invio e la pubblicazione il video ESCE comunque,
//    e parte un avviso senza nomi — il criterio di prima è rovesciato apposta.
// 3. Questa rotta risponde 409 `VIDEO_APP_DA_AGGIORNARE` a chi la chiede ancora per
//    un video: è un client col JS vecchio, rimasto aperto, e va aggiornato.
//
// Quello che questo file deve poter dire è che il 409 è DAVVERO l'unica cosa che
// succede: nessuna lettura, nessuna copia, nessuna RPC, nessuna notifica, nessun
// cancello interpellato. E che la pubblicazione di una FOTO non è cambiata.
// =============================================================================

const SEDE = SEDE_A
const DOCENTE = '22222222-2222-4222-8222-222222222222'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const INTENT = 'e1e1e1e1-1111-4111-8111-eeeeeeeeeeee'
const MEDIA = 'd1d1d1d1-1111-4111-8111-dddddddddddd'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

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
    // ─ quanto il finto database e il finto Storage sono stati toccati ─
    clientCreati: 0,
    tabelleLette: [] as string[],
    insertRecord: [] as Array<Record<string, unknown>>,
    rpcChiamate: [] as Array<{ nome: string; args: Record<string, unknown> }>,
    storageToccato: [] as string[],
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
    createAdminClient: async () => {
        h.clientCreati++
        return {
            rpc(nome: string, args: Record<string, unknown>) {
                h.rpcChiamate.push({ nome, args })
                return Promise.resolve({ data: { ok: true }, error: null })
            },
            storage: {
                from(bucket: string) {
                    const tocca = (op: string) => async () => {
                        h.storageToccato.push(`${bucket}:${op}`)
                        return { data: null, error: null }
                    }
                    return { copy: tocca('copy'), remove: tocca('remove'), list: tocca('list'), info: tocca('info') }
                },
            },
            from(tabella: string) {
                h.tabelleLette.push(tabella)
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
                if (tabella !== 'galleria_media_v2') {
                    // Le tabelle della pipeline video (`video_intents`, `video_jobs`) non
                    // le legge più nessuno, da questa rotta: se qualcuno le rimette, il
                    // test rompe qui, col nome della tabella.
                    throw new Error(`tabella non prevista da questo test: "${tabella}"`)
                }
                return {
                    insert(record: Record<string, unknown>) {
                        h.insertRecord.push({ ...record })
                        const esito = { data: { id: MEDIA, ...record }, error: null }
                        return { select: () => ({ single: async () => esito }) }
                    },
                }
            },
        }
    },
}))

import { POST } from '@/app/api/gallery/route'

const post = (body: unknown) =>
    new NextRequest('http://localhost/api/gallery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

/** Il corpo che mandava il client del flusso vecchio per pubblicare un video convertito. */
const corpoVideoVecchio = (extra: Record<string, unknown> = {}) => ({
    video_intent_id: INTENT,
    video_revisione: 1,
    scuola_id: SEDE,
    caption: 'La recita',
    tag_students: [ALU_1, ALU_2],
    ...extra,
})

const eventiGalleria = () => log.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

/** Tutto ciò che il test ha toccato oltre al 409: dev'essere VUOTO per un video. */
const effetti = () => ({
    clientCreati: h.clientCreati,
    tabelle: h.tabelleLette,
    insert: h.insertRecord,
    rpc: h.rpcChiamate,
    storage: h.storageToccato,
    sede: h.resolveScuolaScrittura.mock.calls.length,
    consenso: h.alunniSenzaConsenso.mock.calls.length,
    notifiche: h.notificaEvento.mock.calls.length,
    genitori:
        h.genitoriDiAlunni.mock.calls.length +
        h.genitoriDiClassi.mock.calls.length +
        h.genitoriDiScuola.mock.calls.length,
})
const NIENTE = {
    clientCreati: 0,
    tabelle: [],
    insert: [],
    rpc: [],
    storage: [],
    sede: 0,
    consenso: 0,
    notifiche: 0,
    genitori: 0,
}

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
    h.clientCreati = 0
    h.tabelleLette = []
    h.insertRecord = []
    h.rpcChiamate = []
    h.storageToccato = []
})

describe('il flusso vecchio dei video: 409, e non succede NIENTE altro', () => {
    it('risponde 409 `VIDEO_APP_DA_AGGIORNARE`, con la frase del catalogo', async () => {
        const res = await POST(post(corpoVideoVecchio()))
        expect(res.status).toBe(409)
        const corpo = await res.json()
        expect(corpo.codice).toBe('VIDEO_APP_DA_AGGIORNARE')
        // La frase è quella del catalogo italiano, la stessa che le tre porte storiche
        // (`gallery/upload`, `gallery/upload-url`, `news/upload`) rispondono per un video.
        expect(corpo.error).toBe(itShared.erroreVideoAppDaAggiornare)
        expect(Object.keys(corpo).sort()).toEqual(['codice', 'error'])
    })

    it('non tocca niente: né database, né Storage, né RPC, né notifiche, né cancelli', async () => {
        // È il punto del compito: «togli il ramo video e la compensazione». Se qualcuno
        // rimette una lettura dell'intento, una copia o una RPC prima del 409, almeno una
        // di queste voci smette di essere vuota.
        await POST(post(corpoVideoVecchio()))
        expect(effetti()).toEqual(NIENTE)
    })

    it.each([
        ['senza la revisione', { video_revisione: undefined }],
        ['con anche un `file_url`', { file_url: 'uploads/x/y.mp4' }],
        ['con un `upload_id`', { upload_id: '33333333-3333-4333-8333-333333333333' }],
        ['con `file_type: video`', { file_type: 'video' }],
        ['senza bambini', { tag_students: [] }],
        ['in broadcast (da un educatore: il 403 del broadcast non scatta)', { is_broadcast: true, tag_students: [] }],
        ['con un bambino di un’altra sede', { scuola_id: SEDE_B, tag_students: ['a9a9a9a9-9999-4999-8999-999999999999'] }],
    ])('risponde 409 qualunque sia la forma della richiesta: %s', async (_nome, extra) => {
        // Una richiesta vecchia non deve cadere su un 400 che non spiega niente, né su un
        // 403/422 dei cancelli: la sua strada è chiusa, e correggere i bambini non la
        // riaprirebbe.
        const res = await POST(post(corpoVideoVecchio(extra)))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('VIDEO_APP_DA_AGGIORNARE')
        expect(effetti()).toEqual(NIENTE)
    })

    it('con la liberatoria mancante il 409 resta 409: il Privacy Lock non viene nemmeno interpellato', async () => {
        h.alunniSenzaConsenso.mockResolvedValue([{ id: ALU_2, nome: 'Bea' }])
        const res = await POST(post(corpoVideoVecchio()))
        expect(res.status).toBe(409)
        expect(JSON.stringify(await res.json())).not.toContain('Bea')
        expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
    })

    it('il gate di ruolo viene PRIMA: chi non ha titolo non impara niente dal 409', async () => {
        h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
        const res = await POST(post(corpoVideoVecchio()))
        expect(res.status).toBe(403)
        expect(
            eventiGalleria().some((c) => c[2]?.esito === 'pubblicazione-video-legacy-rifiutata'),
            'un anonimo non deve poter far scrivere righe di log del flusso vecchio',
        ).toBe(false)
    })

    it('un `video_intent_id` malformato è un 400 di validazione, non un 409', async () => {
        const res = await POST(post(corpoVideoVecchio({ video_intent_id: 'non-un-uuid' })))
        expect(res.status).toBe(400)
        expect(effetti()).toEqual(NIENTE)
    })
})

describe('il rifiuto del flusso vecchio lascia una riga, e solo di uuid', () => {
    it('`warn`, canale galleria, `pubblicazione-video-legacy-rifiutata`, con l’intento', async () => {
        await POST(post(corpoVideoVecchio()))

        const righe = eventiGalleria().filter((c) => c[2]?.esito === 'pubblicazione-video-legacy-rifiutata')
        expect(righe, 'il rifiuto muto non distingue «hanno aggiornato tutti» da «non lo sappiamo»').toHaveLength(1)
        const [, livello, campi, errore, opzioni] = righe[0]
        expect(livello).toBe('warn')
        expect(campi).toEqual({
            operazione: 'gallery:POST',
            esito: 'pubblicazione-video-legacy-rifiutata',
            error_code: 'CLIENT_UPDATE_REQUIRED',
            intento: INTENT,
        })
        expect(errore).toBeUndefined()
        // `app_log` conserva il contesto della PRIMA occorrenza del giorno: senza
        // `distingui` venti video rifiutati sarebbero una riga che nomina un intento solo.
        expect(opzioni).toEqual({ distingui: ['intento'] })
    })

    it('mai la didascalia, mai un bambino: nessun log di tutta la richiesta li contiene', async () => {
        await POST(post(corpoVideoVecchio({ caption: 'Marco-al-parco.mp4' })))
        const tutto = JSON.stringify(log.logEvento.mock.calls) + JSON.stringify(log.logErrore.mock.calls)
        expect(tutto).not.toContain('Marco-al-parco')
        expect(tutto).not.toContain('La recita')
        expect(tutto).not.toContain(ALU_1)
        expect(tutto).not.toContain(ALU_2)
    })
})

describe('il contratto del corpo', () => {
    it('senza `video_intent_id` il `file_url` resta obbligatorio (regressione)', async () => {
        const res = await POST(post({ scuola_id: SEDE, caption: 'niente file' }))
        expect(res.status).toBe(400)
        expect(h.insertRecord).toEqual([])
    })

    it('`upload_id` su un contenuto che non è una foto resta un 400', async () => {
        const res = await POST(
            post({
                file_url: `uploads/${DOCENTE}/1.mp4`,
                file_type: 'video',
                upload_id: '33333333-3333-4333-8333-333333333333',
                scuola_id: SEDE,
            }),
        )
        expect(res.status).toBe(400)
        expect(h.insertRecord).toEqual([])
    })
})

describe('la pubblicazione di una FOTO non cambia di una riga', () => {
    it('nessuna copia, nessuna RPC, stessa riga di prima (con la didascalia nulla)', async () => {
        const res = await POST(
            post({ file_url: 'uploads/ed1/1.jpg', file_type: 'foto', scuola_id: SEDE, tag_students: [ALU_1] }),
        )
        expect(res.status).toBe(201)
        expect(h.storageToccato).toEqual([])
        expect(h.rpcChiamate).toEqual([])
        expect(h.insertRecord[0].file_url).toBe('uploads/ed1/1.jpg')
        expect(h.insertRecord[0].file_type).toBe('foto')
        expect(h.insertRecord[0].caption).toBeNull()
        expect(h.tabelleLette).not.toContain('video_intents')
        expect(h.tabelleLette).not.toContain('video_jobs')
    })

    it('la sede sbagliata resta un rifiuto, e il Privacy Lock non parte', async () => {
        h.resolveScuolaScrittura.mockResolvedValue({
            response: new Response(null, { status: 400 }),
        })
        const res = await POST(
            post({ file_url: 'uploads/ed1/1.jpg', scuola_id: SEDE_B, tag_students: [ALU_1, ALU_2] }),
        )
        expect(res.status).toBe(400)
        expect(h.alunniSenzaConsenso).not.toHaveBeenCalled()
        expect(h.insertRecord).toEqual([])
    })

    it('la liberatoria mancante su una FOTO di gruppo resta un 422 con i nomi (per il client dell’insegnante)', async () => {
        h.alunniSenzaConsenso.mockResolvedValue([{ id: ALU_2, nome: 'Bea' }])
        const res = await POST(
            post({ file_url: 'uploads/ed1/1.jpg', scuola_id: SEDE, tag_students: [ALU_1, ALU_2] }),
        )
        expect(res.status).toBe(422)
        const corpo = await res.json()
        expect(corpo.nomi).toEqual(['Bea'])
        expect(corpo.ids).toEqual([ALU_2])
        expect(h.insertRecord).toEqual([])
        // …e il log resta di soli conteggi.
        const riga = eventiGalleria().find((c) => c[2]?.esito === 'liberatoria-mancante')
        expect(riga?.[2]).toEqual({
            operazione: 'gallery:POST',
            esito: 'liberatoria-mancante',
            taggati: 2,
            senzaConsenso: 1,
        })
        expect(JSON.stringify(riga)).not.toContain('Bea')
    })

    it('la riga di successo non ha più il flag `video` (questa rotta pubblica solo foto)', async () => {
        await POST(post({ file_url: 'uploads/ed1/1.jpg', scuola_id: SEDE, tag_students: [ALU_1] }))
        const riga = eventiGalleria().find((c) => c[2]?.esito === 'pubblicata')
        expect(riga?.[2]?.sede_id).toBe(SEDE)
        expect(riga?.[2]).not.toHaveProperty('video')
        expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    })
})
