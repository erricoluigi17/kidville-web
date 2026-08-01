import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// S35 · L'ALLEGATO CARICATO E MAI PUBBLICATO.
//
// Il difetto misurato in produzione il 2026-07-31: in `avvisi_allegati` c'era un
// oggetto che nessun avviso referenziava (`1779633720167-…pdf`, 24/05/2026). È il
// residuo del gesto più normale che ci sia — si allega un PDF, ci si ripensa, si
// chiude il modulo — perché `removeFile` e la chiusura toglievano il file dalla
// BOZZA e mai dal bucket. Un documento di una comunicazione scolastica (il modulo
// di una gita coi nomi dei bambini, un certificato) conservato per sempre senza
// che nessuna riga lo nomini è un dato tenuto senza uno scopo, e nessuno può
// nemmeno accorgersene: non compare in nessuna schermata.
//
// LA PARTE DELICATA NON È CANCELLARE, È NON CANCELLARE TROPPO. Un endpoint di
// rimozione è, se scritto male, il modo di cancellare l'allegato dell'avviso di
// un altro: il percorso si legge dal link firmato che la bacheca restituisce a
// chiunque possa vederla. Perciò due gate, e questo file li mette alla prova
// entrambi ASSERENDO SULLA MUTAZIONE (quali `remove` sono partite davvero, con
// quali percorsi), mai sullo status:
//
//   1. SIGILLO — si rimuove solo un file caricato in QUESTA sessione da QUESTO
//      utente: l'upload restituisce un sigillo HMAC che lega percorso, bucket,
//      utente e scadenza. Un sigillo altrui, scaduto, assente o riferito a un
//      altro percorso non apre niente.
//   2. NESSUN AVVISO LO USA — anche col sigillo buono, se una riga referenzia
//      quel file il file resta. È la difesa contro il sigillo riusato dopo la
//      pubblicazione, e contro l'avviso di un'ALTRA sede che punta allo stesso
//      oggetto (il bucket è uno per tutte e tre).
//
// Ogni asserzione negativa ha il suo controllo positivo: «non rimuove» vale solo
// se, cambiata la sola condizione in esame, nello stesso mock rimuove davvero.
// =============================================================================

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const UTENTE = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALTRO_UTENTE = 'bbbbbbbb-0000-4000-8000-00000000000c'
const PERCORSO = '1785526750670-91plab2.pdf'
const BUCKET = 'avvisi_allegati'

interface Operazione { tabella: string; sel: string; filtri: Record<string, unknown> }

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; err?: unknown }[],
    errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
    operazioni: [] as Operazione[],
    rimozioni: [] as { bucket: string; percorsi: string[] }[],
    /** Altri avvisi che puntano allo stesso file. */
    altriRiferimenti: [] as { id: string }[],
    erroreRicerca: null as { code: string; message: string } | null,
    erroreRemove: null as { message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
        h.eventi.push({ evento, livello, campi, err })
    },
    logErrore: (contesto: Record<string, unknown>, err: unknown) => { h.errori.push({ contesto, err }) },
}))

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from(tabella: string) {
            const q: Operazione = { tabella, sel: '', filtri: {} }
            const esegui = () => {
                h.operazioni.push({ ...q, filtri: { ...q.filtri } })
                if (h.erroreRicerca) return { data: null, error: h.erroreRicerca }
                return { data: h.altriRiferimenti, error: null }
            }
            const b: Record<string, unknown> = {}
            b.select = (s?: string) => { if (typeof s === 'string') q.sel = s; return b }
            b.eq = (c: string, v: unknown) => { q.filtri[c] = v; return b }
            b.neq = (c: string, v: unknown) => { q.filtri[`neq:${c}`] = v; return b }
            b.ilike = (c: string, v: unknown) => { q.filtri[`ilike:${c}`] = v; return b }
            b.limit = () => b
            b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                Promise.resolve(esegui()).then(onF, onR)
            return b
        },
        storage: {
            from: (bucket: string) => ({
                remove: async (percorsi: string[]) => {
                    h.rimozioni.push({ bucket, percorsi })
                    return h.erroreRemove
                        ? { data: null, error: h.erroreRemove }
                        : { data: percorsi.map((p) => ({ name: p })), error: null }
                },
            }),
        },
    }),
}))

// Il sigillo NON è mockato: è la cosa da mettere alla prova. Il segreto è finto e
// vive solo dentro questo processo di test.
vi.stubEnv('OTP_TICKET_SECRET', 'sigillo-finto-per-i-test')

import { POST as RIMUOVI } from '@/app/api/avvisi/upload/rimuovi/route'
import { firmaRimozioneAllegato } from '@/lib/allegati/sigillo'
import { BUCKET_AVVISI_ALLEGATI } from '@/lib/allegati/storage'

const req = (body: unknown) => ({
    url: 'http://test/api/avvisi/upload/rimuovi',
    method: 'POST',
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams() },
    cookies: { get: () => undefined },
    json: async () => body,
}) as never

const sigilloDi = (utente: string, percorso = PERCORSO) =>
    firmaRimozioneAllegato({ bucket: BUCKET_AVVISI_ALLEGATI, percorso, utenteId: utente })

beforeEach(() => {
    vi.clearAllMocks()
    h.eventi = []
    h.errori = []
    h.operazioni = []
    h.rimozioni = []
    h.altriRiferimenti = []
    h.erroreRicerca = null
    h.erroreRemove = null
    h.requireDocente.mockResolvedValue({ user: { id: UTENTE, role: 'segreteria', scuola_id: SEDE } })
})

afterEach(() => { vi.useRealTimers() })

describe('POST /api/avvisi/upload/rimuovi — il file della bozza abbandonata', () => {
    it('CONTROLLO POSITIVO · sigillo valido e nessun avviso che lo usa → il file esce dal bucket', async () => {
        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ rimosso: true })
        expect(h.rimozioni).toEqual([{ bucket: BUCKET, percorsi: [PERCORSO] }])
    })

    it('IL SUCCESSO SI LOGGA, e nella riga non finisce il nome del file', async () => {
        await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        const riga = h.eventi.find((e) => e.evento === 'storage' && e.campi.esito === 'allegati-rimossi')
        expect(riga).toBeDefined()
        expect(riga!.campi).toMatchObject({ operazione: 'avvisi/upload/rimuovi:POST', n_rimossi: 1 })
        // Il nome dice di quale comunicazione si tratta: resta fuori dal log.
        expect(JSON.stringify(h.eventi)).not.toContain(PERCORSO)
    })

    it('sigillo di un ALTRO utente → 403 e il file NON si tocca', async () => {
        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(ALTRO_UTENTE) }))

        expect(res.status).toBe(403)
        expect(h.rimozioni, 'con il sigillo di un altro non si cancella niente').toHaveLength(0)
        expect((await res.json()).codice).toBe('ALLEGATO_NON_RIMOSSO')
    })

    it('sigillo valido ma per un ALTRO percorso → 403 e nessuna rimozione', async () => {
        // È il tentativo vero: si prende il sigillo del proprio upload e si cambia il
        // percorso, puntando all'allegato dell'avviso di qualcun altro.
        const res = await RIMUOVI(req({ percorso: 'allegato-di-un-altro.pdf', sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(403)
        expect(h.rimozioni).toHaveLength(0)
    })

    it('sigillo SCADUTO → 403 e nessuna rimozione', async () => {
        const sigillo = sigilloDi(UTENTE)
        // Un giorno dopo: la finestra di una bozza aperta è molto più corta.
        vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000))

        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo }))

        expect(res.status).toBe(403)
        expect(h.rimozioni).toHaveLength(0)
    })

    it('sigillo ASSENTE → 400/403, e comunque nessuna rimozione', async () => {
        const res = await RIMUOVI(req({ percorso: PERCORSO }))

        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(h.rimozioni).toHaveLength(0)
    })

    it('UN AVVISO PUNTA A QUEL FILE → non si rimuove, nemmeno col sigillo giusto', async () => {
        h.altriRiferimenti = [{ id: 'avviso-di-un-altro' }]

        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ rimosso: false })
        expect(h.rimozioni, 'cancellarlo romperebbe l’allegato di un avviso pubblicato').toHaveLength(0)
        // La ricerca c'è stata, e cercava proprio quel percorso.
        const ricerca = h.operazioni.find((o) => o.tabella === 'avvisi')
        expect(ricerca).toBeDefined()
        expect(String(ricerca!.filtri['ilike:attachment_url'])).toContain(PERCORSO)
    })

    it('se la ricerca degli avvisi fallisce → NON si cancella (fail-safe) e resta una riga warn', async () => {
        h.erroreRicerca = { code: '08006', message: 'connection failure' }

        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(200)
        expect(h.rimozioni, 'un file cancellato per sbaglio non si recupera: nel dubbio resta').toHaveLength(0)
        expect(h.eventi.find((e) => e.campi.esito === 'allegato-non-verificabile')?.livello).toBe('warn')
    })

    it('il gate di ruolo viene PRIMA di tutto: respinto dall’auth, nessuna ricerca e nessuna rimozione', async () => {
        h.requireDocente.mockResolvedValue({
            response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }),
        })

        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(401)
        expect(h.rimozioni).toHaveLength(0)
        expect(h.operazioni).toHaveLength(0)
    })

    it('lo Storage che fallisce non diventa un 500: la bozza è comunque perduta, e il guasto si legge nel log', async () => {
        h.erroreRemove = { message: 'Object not found' }

        const res = await RIMUOVI(req({ percorso: PERCORSO, sigillo: sigilloDi(UTENTE) }))

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ rimosso: false })
        const riga = h.eventi.find((e) => e.evento === 'storage' && e.livello === 'error')
        expect(riga).toBeDefined()
        expect(JSON.stringify(riga!.err), 'il corpo dell’errore del fornitore non si butta via').toContain('Object not found')
    })
})

describe('il sigillo, di per sé', () => {
    it('senza segreto non si firma niente e non si verifica niente (fail-closed)', async () => {
        vi.stubEnv('OTP_TICKET_SECRET', '')
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
        const { firmaRimozioneAllegato: firmaSenzaSegreto, verificaRimozioneAllegato } =
            await import('@/lib/allegati/sigillo')

        const s = firmaSenzaSegreto({ bucket: BUCKET, percorso: PERCORSO, utenteId: UTENTE })

        expect(s, 'senza segreto non si emette un sigillo che non protegge niente').toBeNull()
        expect(
            verificaRimozioneAllegato({ bucket: BUCKET, percorso: PERCORSO, utenteId: UTENTE, sigillo: 'qualunque' }),
            'e soprattutto non si verifica: un sigillo che passa sempre è peggio di nessun sigillo',
        ).toBe(false)
        vi.unstubAllEnvs()
        vi.stubEnv('OTP_TICKET_SECRET', 'sigillo-finto-per-i-test')
    })
})
