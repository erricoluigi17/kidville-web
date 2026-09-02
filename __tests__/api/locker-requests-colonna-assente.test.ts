import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET/PATCH /api/locker/requests` — la tolleranza d'ambiente non deve
 * inghiottire una COLONNA mancante.
 *
 * IL DIFETTO. `tabellaMancante()` qui era una copia con un regex sul MESSAGGIO:
 *
 *     error.code === '42P01' || /does not exist|schema cache|could not find/i.test(message)
 *
 * `42703` di PostgREST è «column "…" does not exist»: cadeva dentro quel regex e
 * veniva trattato come «tabella assente». In questa route la tolleranza fa
 * ritornare un ELENCO VUOTO — quindi una migrazione applicata a metà su un
 * database vivo diventava «nessuna richiesta armadietto». Il genitore vedeva zero
 * righe, e nessuno poteva sapere perché.
 *
 * ⚠️ MISURATO il 2026-08-04: `locker_requests` NON ESISTE nel database di
 * produzione (le tabelle vere sono `armadietto` e `locker_config`). Il ramo
 * tollerato era quindi quello che girava SEMPRE in produzione — motivo in più
 * perché non debba coprire anche i guasti veri.
 *
 * DAL 2026-09-01 la route legge `armadietto_richieste`, che in produzione c'è, e
 * il ramo tollerato è tornato a essere quello che dovrebbe: il DB E2E della CI,
 * progetto separato e non migrato. Il nome della tabella è cambiato QUI DENTRO
 * insieme alla route, e non è un dettaglio di forma: il finto client discrimina
 * `from(tabella)` per nome: con quello vecchio l'elenco `h.elenco` non veniva
 * più servito a nessuno, e queste prove misuravano lo stub degli `alunni`
 * invece della route. Un lock che guarda una tabella che la route non
 * interroga più è verde su niente.
 *
 * Test di COMPORTAMENTO, non di nome: si guardano lo stato della risposta e il
 * suo corpo, non se una certa funzione è stata chiamata.
 */

const ALUNNO = '11111111-1111-1111-1111-111111111111'
type ErrDb = { code?: string; message?: string } | null

const h = vi.hoisted(() => ({
    requireParentOfStudent: vi.fn(),
    requireDocente: vi.fn(),
    /** Esito della SELECT su `armadietto_richieste` (il thenable della catena). */
    elenco: { data: null as unknown, error: null as { code?: string; message?: string } | null },
    /**
     * Esito della SELECT su `alunni` — il primo tempo del ramo docente.
     *
     * È uno stato A SÉ, e deve esserlo: fino al 2026-09-01 il finto client
     * restituiva `{ data: [{ id }], error: null }` a chiunque non fosse
     * `armadietto_richieste`, quindi quella query non poteva FALLIRE nemmeno
     * volendo — ed è precisamente il caso che il difetto riguardava.
     */
    alunni: { data: null as unknown, error: null as { code?: string; message?: string } | null },
    /** Esito della `maybeSingle()` con cui la PATCH carica la riga. */
    riga: { data: null as unknown, error: null as { code?: string; message?: string } | null },
    /** Esito della `single()` in coda alla UPDATE della PATCH. */
    aggiornata: { data: null as unknown, error: null as { code?: string; message?: string } | null },
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
    assertAlunnoInScope: async () => null,
    assertClasseNomeInScope: async () => null,
    // Il gemello per UUID: da quando la classe si identifica con `section_id`
    // (2026-09-02) `risolviSezione` sceglie fra i due gate.
    assertSezioneInScope: async () => null,
    scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: (tabella: string) => {
            const b: Record<string, unknown> = {}
            for (const m of ['select', 'eq', 'in', 'order']) b[m] = () => b
            b.update = () => { b.__update = true; return b }
            b.maybeSingle = async () => h.riga
            b.single = async () => h.aggiornata
            b.then = (res: (v: unknown) => unknown) => {
                // `sections` risponde SEMPRE bene, e separatamente: è la
                // traduzione nome→uuid che la route fa PRIMA di leggere gli
                // alunni. Se le si desse la stessa risposta di `alunni`, un
                // `h.alunni` in errore diventerebbe un guasto sulle SEZIONI —
                // la route uscirebbe con `[]` e questo test proverebbe un'altra
                // cosa da quella che dice di provare.
                if (tabella === 'sections') return res({ data: [{ id: 'sec-1' }], error: null })
                return res(tabella === 'armadietto_richieste' ? h.elenco : h.alunni)
            }
            return b
        },
    }),
}))

import { GET, PATCH } from '@/app/api/locker/requests/route'

const getReq = (qs: string) =>
    ({ url: `http://test/api/locker/requests?${qs}`, headers: new Headers(), cookies: { get: () => undefined } }) as never

// `alunno_id` nel corpo e `stato: 'evasa'` dal 2026-09-01: il gate segue il gesto,
// e questo è il ramo SCUOLA (`requireDocente`, finto qui sopra). La riga finta ha
// lo stesso `alunno_id`, altrimenti la route risponde 404 prima di arrivare al
// punto che queste prove misurano — la tolleranza di schema.
const patchReq = () =>
    new Request('http://test/api/locker/requests', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '22222222-2222-2222-2222-222222222222', alunno_id: ALUNNO, stato: 'evasa' }),
    }) as never

const errore = (code: string, message: string): ErrDb => ({ code, message })

beforeEach(() => {
    vi.clearAllMocks()
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
    h.elenco = { data: [], error: null }
    h.alunni = { data: [{ id: ALUNNO }], error: null }
    h.riga = { data: { id: 'req-1', alunno_id: ALUNNO }, error: null }
    h.aggiornata = { data: { id: 'req-1', stato: 'evasa' }, error: null }
})

describe('GET /api/locker/requests — tabella assente vs colonna assente', () => {
    it('42P01 (tabella assente) → 200 con elenco vuoto: tolleranza d\'ambiente', async () => {
        h.elenco = { data: null, error: errore('42P01', 'relation "armadietto_richieste" does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })

    it('PGRST205 (tabella fuori dalla schema cache) → 200 con elenco vuoto', async () => {
        h.elenco = {
            data: null,
            error: errore('PGRST205', "Could not find the table 'public.armadietto_richieste' in the schema cache"),
        }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })

    it('42703 (COLONNA assente) → 500, NON un elenco vuoto', async () => {
        // Il cuore del difetto: «zero richieste armadietto» non è una risposta
        // accettabile a una migrazione applicata a metà.
        h.elenco = { data: null, error: errore('42703', 'column armadietto_richieste.promemoria_inviato_il does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual([])
    })

    it('il 500 non racconta lo schema al chiamante (né tabella né colonna)', async () => {
        h.elenco = { data: null, error: errore('42703', 'column armadietto_richieste.promemoria_inviato_il does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('armadietto_richieste')
        expect(corpo).not.toContain('promemoria_inviato_il')
    })

    it('ramo docente (classe_sezione): 42703 → 500, 42P01 → elenco vuoto', async () => {
        // Due strade nella stessa route: la correzione vale per tutte e due o
        // per nessuna. È la forma con cui questo difetto è sopravvissuto finora.
        h.elenco = { data: null, error: errore('42703', 'column x does not exist') }
        expect((await GET(getReq('classe_sezione=Rossi'))).status).toBe(500)

        h.elenco = { data: null, error: errore('42P01', 'relation does not exist') }
        const ok = await GET(getReq('classe_sezione=Rossi'))
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual([])
    })
})

describe('GET /api/locker/requests — la lettura degli ALUNNI non fallisce in silenzio', () => {
    /**
     * IL DIFETTO, e perché sta in questo file e non altrove.
     *
     * Il ramo docente legge in due tempi: prima gli alunni della sezione (dentro
     * i propri plessi), poi le loro richieste. Fino al 2026-09-01 il primo tempo
     * era scritto `const { data: alunni } = await …`: l'`error` non veniva
     * nemmeno raccolto. PostgREST non lancia (regola 7 di AGENTS.md), quindi una
     * query fallita lasciava `alunni` a `null`, il `if (!alunni …) return []`
     * scattava e la route rispondeva `200 []` SENZA LOGGARE NIENTE.
     *
     * La maestra vedeva la sezione vuota. «Nessun bambino qui» e «non ho potuto
     * guardare» si leggevano uguali — la stessa ambiguità che aveva tenuto
     * nascosti 226 errori per 28 giorni, in questa stessa route.
     *
     * Fallisce CHIUSO (non esce nessun dato), quindi non era un buco di
     * sicurezza: era un guasto invisibile, che è la categoria che questo file
     * esiste per bloccare. Le due prove sono simmetriche a quelle di sopra: la
     * tolleranza d'ambiente resta, il guasto no.
     */
    it('42703 sugli ALUNNI → 500, NON un 200 con elenco vuoto e muto', async () => {
        h.alunni = { data: null, error: errore('42703', 'column alunni.classe_sezione does not exist') }
        // L'elenco delle richieste è SANO: se la route rispondesse `[]` non
        // sarebbe «non c'erano richieste», sarebbe «non so nemmeno chi guardare».
        h.elenco = { data: [{ id: 'r1' }], error: null }

        const res = await GET(getReq('classe_sezione=Rossi'))

        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual([])
    })

    it('il 500 sugli ALUNNI non racconta lo schema al chiamante', async () => {
        h.alunni = { data: null, error: errore('42703', 'column alunni.classe_sezione does not exist') }
        const res = await GET(getReq('classe_sezione=Rossi'))
        // Lo stato SI ASSERISCE anche qui, e non è una ripetizione: senza, un `[]`
        // muto passerebbe questa prova a mani basse — non contiene nomi di schema
        // perché non contiene niente. Sarebbe un lock immunizzato proprio contro
        // il difetto che deve sorvegliare.
        expect(res.status).toBe(500)
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('alunni')
        expect(corpo).not.toContain('classe_sezione')
    })

    it('42P01 sugli ALUNNI → 200 con elenco vuoto: la tolleranza d\'ambiente resta', async () => {
        // Il controllo negativo. Senza, la correzione potrebbe essere «500 su
        // qualunque errore», che farebbe rossa la CI sul DB E2E non migrato — e
        // un lock che pretende una correzione sbagliata viene zittito, non seguito.
        h.alunni = { data: null, error: errore('42P01', 'relation "alunni" does not exist') }
        const res = await GET(getReq('classe_sezione=Rossi'))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })

    it('sezione davvero VUOTA → 200 con elenco vuoto (e non è un guasto)', async () => {
        // L'altra metà della distinzione: `[]` deve continuare a significare
        // «nessun bambino iscritto in questa sezione» quando è vero.
        h.alunni = { data: [], error: null }
        const res = await GET(getReq('classe_sezione=Rossi'))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })
})

describe('PATCH /api/locker/requests — tabella assente vs colonna assente', () => {
    it('42P01 sulla lettura della riga → degrada dichiarato (ok/degraded)', async () => {
        h.riga = { data: null, error: errore('42P01', 'relation "armadietto_richieste" does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, degraded: true })
    })

    it('42703 sulla lettura della riga → 500, NON un «fatto» che non ha fatto niente', async () => {
        // `{ ok: true }` su una colonna mancante è la bugia peggiore: chi ha
        // chiesto il cambio di stato crede che sia avvenuto.
        h.riga = { data: null, error: errore('42703', 'column stato does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual({ ok: true, degraded: true })
    })

    it('42703 sulla UPDATE → 500 (il secondo punto della stessa route)', async () => {
        h.aggiornata = { data: null, error: errore('42703', 'column presa_in_carico_il does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual({ ok: true, degraded: true })
    })

    it('42P01 sulla UPDATE → degrada dichiarato', async () => {
        h.aggiornata = { data: null, error: errore('42P01', 'relation "armadietto_richieste" does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, degraded: true })
    })

    it('il 500 della PATCH non racconta lo schema al chiamante', async () => {
        h.aggiornata = { data: null, error: errore('42703', 'column presa_in_carico_il does not exist') }
        const corpo = JSON.stringify(await (await PATCH(patchReq())).json())
        expect(corpo).not.toContain('presa_in_carico_il')
        expect(corpo).not.toContain('armadietto_richieste')
    })
})
