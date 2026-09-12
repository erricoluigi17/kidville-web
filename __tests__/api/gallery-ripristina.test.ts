import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
 * `POST /api/gallery/ripristina` — LA FOTO TORNA DAL CESTINO
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 *
 * Dal 2026-09-11 «Elimina» non distrugge: archivia. Il dialogo che l'insegnante
 * legge prima di premere (`DialogoEliminaMedia.tsx`) lo dice con queste parole —
 * «la segreteria può ripristinarla entro 30 giorni» — e fino a questa rotta
 * quella frase era una promessa che il sistema non manteneva: la riga restava nel
 * cestino e nessun codice sapeva riportarla indietro. Un'interfaccia che promette
 * ciò che il sistema non fa è un difetto, non un dettaglio.
 *
 * ─── LE COSE CHE QUESTO FILE PROVA, E NON ARGOMENTA ─────────────────────────
 *   1. l'INSEGNANTE è escluso: `requireStaff`, non `requireDocente`. Chi elimina
 *      non annulla — è ciò che tiene «Elimina» un gesto a basso rischio;
 *   2. la sede è quella DEL MEDIA e viene verificata: la segreteria di un plesso
 *      non ripesca la foto di un minore di un altro, e una riga senza plesso si
 *      NEGA (era il difetto misurato su `gallery:DELETE`, dove la condizione
 *      diceva il contrario del commento che le stava sopra);
 *   3. il 409 non è un ripiego: una foto VIVA e una foto il cui FILE è stato
 *      distrutto non si ripristinano, e la seconda perché in galleria
 *      comparirebbe un'immagine rotta;
 *   4. la corsa fra due impiegate si decide DENTRO l'UPDATE, non nel controllo
 *      qui sopra: il secondo arrivato riceve 409, non un finto successo;
 *   5. l'audit c'è (`audit_scritture_docente`) e il log di successo c'è, SENZA la
 *      didascalia — che in questa scuola è il nome del file, cioè spesso il nome
 *      di un bambino;
 *   6. il degrado su `42703`/`PGRST204` (il DB E2E della CI, non migrato) NON
 *      produce un 500 e NON scrive niente.
 *
 * ─── DUE SCELTE DI METODO, PERCHÉ UN TEST VERDE NON BASTA ───────────────────
 *
 * ⚠️ IL GATE NON È MOCKATO. `requireStaff` è quello VERO: l'identità entra dal
 * percorso header (`x-user-id`, l'auth applicativa di questo repo) e il ruolo lo
 * legge dalla tabella `utenti` del finto database. Mockando il gate, la prova «un
 * educator riceve 403» avrebbe verificato il mock — sarebbe stata verde anche
 * scrivendo `requireDocente` nella rotta, cioè esattamente il difetto che deve
 * scoprire.
 *
 * ⚠️ IL FINTO DATABASE APPLICA I FILTRI DAVVERO — `.eq()`, `.in()`, `.is()`,
 * `.not()`, e le mutazioni di `.update()` — e sa dire `42703` SOLO alle query che
 * nominano una colonna del cestino, come fa PostgREST su un impianto non migrato.
 * Un mock piatto sarebbe verde con la correzione e senza; in questo repo è già
 * successo. La controprova è stata ESEGUITA, non promessa: togliendo alla rotta il
 * controllo di sede, tre prove di questo file diventano rosse (la loro identità è
 * scritta accanto a ciascuna).
 *
 * ⚠️ NIENTE DATI VERI: uuid, nomi e didascalie sono inventati. In produzione ci
 * sono anagrafiche di minori e questo repository è pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

// uuid validi nel formato 8-4-4-4-12 che `zUuid` (z.guid) pretende. Inventati.
const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SEGR_A = '5e9e0000-0000-4000-8000-00000000000a'
const EDU_A = 'edu00000-0000-4000-8000-00000000000a'
const ADMIN_A = 'ad000000-0000-4000-8000-00000000000a'
const IGNOTO = '00000000-0000-4000-8000-000000000000'

const CESTINATA_A = 'c0100000-0000-4000-8000-000000000001'
const VIVA_A = 'f0100000-0000-4000-8000-000000000002'
const PURGATA_A = 'c0100000-0000-4000-8000-000000000003'
const CESTINATA_B = 'c0200000-0000-4000-8000-00000000000b'
const SENZA_SEDE = 'c0300000-0000-4000-8000-000000000004'
const MAI_ESISTITA = 'f0900000-0000-4000-8000-000000000009'

/**
 * La didascalia è il campo che non deve MAI comparire in un log né in una
 * risposta. In produzione è il nome del file scelto da chi carica, e nella pratica
 * di questa scuola è «<nome> al parco.jpg»: il nome di un bambino. Qui è una
 * stringa inventata e riconoscibile, così cercarla è una misura e non un'impressione.
 */
const DIDASCALIA = 'PAROLA-CHE-NON-DEVE-FINIRE-NEI-LOG'

/** Quando sono state cestinate le righe di prova: 3 giorni fa, orologio congelato. */
const ADESSO = new Date('2026-09-12T10:00:00.000Z')
const TRE_GIORNI_FA = '2026-09-09T10:00:00.000Z'
/** Oltre i 30 giorni di grazia: la purga avrebbe già dovuto portarla via. */
const QUARANTA_GIORNI_FA = '2026-08-03T10:00:00.000Z'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
    logEvento: vi.fn(),
    media: [] as Riga[],
    utenti: [] as Riga[],
    utentiScuole: [] as Riga[],
    /** Ogni SCRITTURA eseguita sul finto database, in ordine. L'unica prova che conta. */
    scritture: [] as Array<{ tabella: string; op: 'insert' | 'update' | 'delete'; patch?: Riga; toccate?: number }>,
    /** Codice PostgREST per le LETTURE che nominano una colonna del cestino. */
    erroreLetturaCestino: null as string | null,
    /** Codice PostgREST per le SCRITTURE che toccano una colonna del cestino. */
    erroreScritturaCestino: null as string | null,
    /** Qualcun altro vince la corsa: gira una volta, appena prima del primo UPDATE. */
    primaDellUpdate: null as (() => void) | null,
}))

// Il logger si intercetta per LEGGERE le righe emesse, non per spegnerle: le
// asserzioni sui log sono metà di ciò che questo file prova.
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: h.logEvento,
}))

// ⚠️ NON si mockano: `@/lib/auth/require-staff` (il gate è il soggetto della
// prova), `@/lib/gallery/cestino` (i filtri li deve scegliere il codice di
// produzione), `@/lib/audit/scrittura` (l'audit si verifica sulla RIGA scritta:
// `logScrittura` scarta gli `entita_id` che non sono uuid, e una riga mai scritta
// in questo repo è già capitata).

// ─────────────────────────────────────────────────────────────────────────────
// Il finto PostgREST — piccolo, ma esegue i filtri e sa dire `42703`
// ─────────────────────────────────────────────────────────────────────────────
type Stato = {
    tabella: string
    op: 'select' | 'insert' | 'update' | 'delete'
    colonne: string
    patch: Riga | null
    eq: Array<[string, unknown]>
    dentro: Array<[string, unknown[]]>
    is: Array<[string, boolean | null]>
    non: Array<[string, string, unknown]>
}

/** Le colonne che su un database NON migrato non esistono. */
const COLONNE_CESTINO = ['eliminato_il', 'eliminato_da', 'file_rimosso_il']

function righeDi(tabella: string): Riga[] {
    if (tabella === 'galleria_media_v2') return h.media
    if (tabella === 'utenti') return h.utenti
    if (tabella === 'utenti_scuole') return h.utentiScuole
    return []
}

/**
 * L'errore che questo impianto darebbe alla query. `42703` in SELECT e `PGRST204`
 * in UPDATE sono i due modi in cui PostgREST dice «quella colonna non esiste», e
 * scattano SOLO se la query le nomina davvero: è ciò che rende il degrado una
 * misura invece di un'asserzione — una query che non le nomina deve continuare a
 * funzionare.
 */
function erroreDi(s: Stato): { code: string } | null {
    const nomina = (dove: string) => COLONNE_CESTINO.some((c) => dove.includes(c))
    const letturaNomina =
        nomina(s.colonne) ||
        s.is.some(([c]) => COLONNE_CESTINO.includes(c)) ||
        s.non.some(([c]) => COLONNE_CESTINO.includes(c))
    if (h.erroreLetturaCestino && letturaNomina) return { code: h.erroreLetturaCestino }
    if (h.erroreScritturaCestino && s.op === 'update' && nomina(Object.keys(s.patch ?? {}).join(','))) {
        return { code: h.erroreScritturaCestino }
    }
    return null
}

function filtra(s: Stato): Riga[] {
    let righe = righeDi(s.tabella).slice()
    for (const [col, val] of s.eq) righe = righe.filter((r) => r[col] === val)
    for (const [col, vals] of s.dentro) righe = righe.filter((r) => vals.includes(r[col] as never))
    for (const [col, val] of s.is) {
        righe = val === null
            ? righe.filter((r) => r[col] === null || r[col] === undefined)
            : righe.filter((r) => r[col] === val)
    }
    for (const [col, op, val] of s.non) {
        if (op !== 'is') throw new Error(`.not(${col}, ${op}) non emulata dal finto DB`)
        righe = val === null
            ? righe.filter((r) => r[col] !== null && r[col] !== undefined)
            : righe.filter((r) => r[col] !== val)
    }
    return righe
}

function esegui(s: Stato): { data: Riga[] | null; error: { code: string } | null } {
    if (s.op === 'update' && h.primaDellUpdate) {
        // La corsa: un'altra impiegata ha premuto Ripristina fra la lettura e
        // questa scrittura. Gira UNA volta sola.
        const spia = h.primaDellUpdate
        h.primaDellUpdate = null
        spia()
    }
    const err = erroreDi(s)
    if (err) return { data: null, error: err }

    if (s.op === 'insert') {
        const riga = { ...(s.patch ?? {}) }
        righeDi(s.tabella).push(riga)
        h.scritture.push({ tabella: s.tabella, op: 'insert', patch: s.patch ?? {} })
        return { data: [riga], error: null }
    }

    const colpite = filtra(s)

    if (s.op === 'update') {
        for (const r of colpite) Object.assign(r, s.patch ?? {})
        h.scritture.push({ tabella: s.tabella, op: 'update', patch: s.patch ?? {}, toccate: colpite.length })
        return { data: colpite, error: null }
    }
    if (s.op === 'delete') {
        h.scritture.push({ tabella: s.tabella, op: 'delete', toccate: colpite.length })
        return { data: colpite, error: null }
    }
    // ⚠️ UNA LETTURA RESTITUISCE COPIE, non le righe vive del finto database, ed è
    // fedeltà e non pignoleria: PostgREST manda JSON, quindi ciò che la rotta ha in
    // mano è uno SCATTO del momento in cui ha letto. Con le righe vive, un UPDATE
    // successivo cambiava sotto i piedi il valore già letto — misurato mentre questo
    // file nasceva: `giorni_nel_cestino` usciva 20708 (cioè `eliminato_il` diventato
    // `null`, e `new Date(null)` è l'epoca) e due prove erano rosse per un difetto
    // del finto database, non della rotta. Un finto database che mente in un verso
    // mente anche nell'altro: domani avrebbe reso VERDE una rotta che legge un dato
    // dopo averlo sovrascritto.
    return { data: colpite.map((r) => ({ ...r })), error: null }
}

const adminClient = {
    from(tabella: string) {
        const s: Stato = { tabella, op: 'select', colonne: '', patch: null, eq: [], dentro: [], is: [], non: [] }
        const b: Record<string, unknown> = {}
        b.select = (cols?: string) => {
            if (cols) s.colonne = cols
            return b
        }
        b.insert = (row: Riga) => { s.op = 'insert'; s.patch = row; return b }
        b.update = (row: Riga) => { s.op = 'update'; s.patch = row; return b }
        b.delete = () => { s.op = 'delete'; return b }
        b.eq = (col: string, val: unknown) => { s.eq.push([col, val]); return b }
        b.in = (col: string, vals: unknown[]) => { s.dentro.push([col, vals]); return b }
        b.is = (col: string, val: boolean | null) => { s.is.push([col, val]); return b }
        b.not = (col: string, op: string, val: unknown) => { s.non.push([col, op, val]); return b }
        b.maybeSingle = async () => {
            const r = esegui(s)
            return { data: r.error ? null : (r.data ?? [])[0] ?? null, error: r.error }
        }
        b.single = async () => {
            const r = esegui(s)
            return { data: r.error ? null : (r.data ?? [])[0] ?? null, error: r.error }
        }
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(esegui(s)).then(res, rej)
        return b
    },
}

vi.mock('@/lib/supabase/server-client', () => ({
    // Nessuna sessione: l'identità arriva dall'header, come nell'auth applicativa
    // di questo repo. È il percorso che fa girare il gate VERO.
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => adminClient,
}))

import { POST } from '@/app/api/gallery/ripristina/route'

const chiama = (body: unknown, userId?: string) =>
    POST(
        new Request('http://localhost/api/gallery/ripristina', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(userId ? { 'x-user-id': userId } : {}),
            },
            body: JSON.stringify(body),
        }),
    )

const mediaDi = (id: string) => h.media.find((m) => m.id === id)
const eventi = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')
const evento = (esito: string) =>
    eventi().find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)?.[2] as Riga | undefined
/** Tutte le chiamate al logger, qualunque canale: serve a cercare la didascalia. */
const tuttiILog = () => JSON.stringify(h.logEvento.mock.calls)
const scrittureSu = (tabella: string) => h.scritture.filter((w) => w.tabella === tabella)
const audit = () => scrittureSu('audit_scritture_docente')

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(ADESSO)
    h.erroreLetturaCestino = null
    h.erroreScritturaCestino = null
    h.primaDellUpdate = null
    h.scritture = []
    h.utentiScuole = []
    // `ruolo` è la colonna scritta; `role` è GENERATA da essa (non si scrive mai)
    // ed è quella che `proiettaAppUser` preferisce: qui coincidono, come in produzione.
    h.utenti = [
        { id: SEGR_A, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A, nome: 'Anna', cognome: 'Inventata' },
        { id: EDU_A, ruolo: 'educator', role: 'educator', scuola_id: SEDE_A, nome: 'Maestra', cognome: 'Inventata' },
        { id: ADMIN_A, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A, nome: 'Dire', cognome: 'Inventata' },
    ]
    h.media = [
        {
            id: CESTINATA_A, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/1.jpg',
            caption: DIDASCALIA, tag_students: [], is_broadcast: false,
            created_at: '2026-09-01T08:00:00.000Z',
            eliminato_il: TRE_GIORNI_FA, eliminato_da: EDU_A, file_rimosso_il: null,
        },
        {
            id: VIVA_A, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/2.jpg',
            caption: null, tag_students: [], is_broadcast: false,
            created_at: '2026-09-02T08:00:00.000Z',
            eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
        },
        {
            // Nel cestino, ma il file è già uscito dallo Storage: NON ripristinabile.
            id: PURGATA_A, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/3.jpg',
            caption: null, tag_students: [], is_broadcast: false,
            created_at: '2026-08-01T08:00:00.000Z',
            eliminato_il: QUARANTA_GIORNI_FA, eliminato_da: EDU_A, file_rimosso_il: '2026-09-02T03:00:00.000Z',
        },
        {
            id: CESTINATA_B, scuola_id: SEDE_B, uploaded_by: 'ed-b', file_url: 'uploads/b/1.jpg',
            caption: null, tag_students: [], is_broadcast: false,
            created_at: '2026-09-03T08:00:00.000Z',
            eliminato_il: TRE_GIORNI_FA, eliminato_da: 'ed-b', file_rimosso_il: null,
        },
        {
            // Riga senza plesso: non è attribuibile a nessuno ⇒ si nega.
            id: SENZA_SEDE, scuola_id: null, uploaded_by: EDU_A, file_url: 'uploads/x/1.jpg',
            caption: null, tag_students: [], is_broadcast: false,
            created_at: '2026-09-03T08:00:00.000Z',
            eliminato_il: TRE_GIORNI_FA, eliminato_da: EDU_A, file_rimosso_il: null,
        },
    ]
})

afterEach(() => {
    vi.useRealTimers()
})

describe('POST /api/gallery/ripristina — il gate', () => {
    it('un ANONIMO riceve 401 e non tocca niente', async () => {
        const res = await chiama({ id: CESTINATA_A })
        expect(res.status).toBe(401)
        expect(h.scritture).toEqual([])
        expect(mediaDi(CESTINATA_A)?.eliminato_il).toBe(TRE_GIORNI_FA)
    })

    /**
     * ⚠️ LA PROVA CHE DISTINGUE `requireStaff` DA `requireDocente`, e l'unica
     * ragione per cui il gate in questo file non è mockato: `requireDocente`
     * ammette `educator`. Con il gate sbagliato nella rotta questa prova risponde
     * 200 e la foto torna in galleria — cioè l'insegnante annulla la propria
     * eliminazione, che è esattamente la cosa che il dialogo promette NON accada.
     */
    it('un EDUCATOR riceve 403: chi elimina non ripristina', async () => {
        const res = await chiama({ id: CESTINATA_A }, EDU_A)
        expect(res.status).toBe(403)
        expect(h.scritture).toEqual([])
        expect(mediaDi(CESTINATA_A)?.eliminato_il).toBe(TRE_GIORNI_FA)
    })

    it('un utente che `utenti` non conosce riceve 403', async () => {
        const res = await chiama({ id: CESTINATA_A }, IGNOTO)
        expect(res.status).toBe(403)
        expect(h.scritture).toEqual([])
    })

    it('un corpo senza `id` (o con un id che non è un uuid) è un 400 di validazione', async () => {
        expect((await chiama({}, SEGR_A)).status).toBe(400)
        expect((await chiama({ id: 'non-un-uuid' }, SEGR_A)).status).toBe(400)
        expect(h.scritture).toEqual([])
    })
})

describe('POST /api/gallery/ripristina — l’isolamento di sede', () => {
    /**
     * ⚠️ CONTROPROVA ESEGUITA: togliendo dalla rotta il blocco
     * `if (sedeMedia === null || !plessi.includes(sedeMedia))` questa prova
     * risponde 200 e la foto di un minore di un ALTRO plesso torna visibile.
     */
    it('la foto di un ALTRO plesso è 403, e resta nel cestino', async () => {
        const res = await chiama({ id: CESTINATA_B }, SEGR_A)
        expect(res.status).toBe(403)
        expect(mediaDi(CESTINATA_B)?.eliminato_il).toBe(TRE_GIORNI_FA)
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        expect(evento('media-fuori-sede')).toBeDefined()
    })

    it('una riga SENZA plesso è 403: non è attribuibile a nessuno', async () => {
        const res = await chiama({ id: SENZA_SEDE }, SEGR_A)
        expect(res.status).toBe(403)
        expect(mediaDi(SENZA_SEDE)?.eliminato_il).toBe(TRE_GIORNI_FA)
        expect(evento('media-senza-sede')).toBeDefined()
    })

    /**
     * L'admin multi-plesso: la sua seconda sede arriva dal ponte `utenti_scuole`
     * (`scuoleDiUtente` lo legge solo per `admin`). Serve a dimostrare che il gate
     * non è «la sede primaria di chi opera» ma l'insieme dei suoi plessi — la
     * distinzione che su tre sedi separa un 403 giusto da uno sbagliato.
     */
    it('l’admin con DUE plessi ripristina anche nel secondo', async () => {
        h.utentiScuole = [{ utente_id: ADMIN_A, scuola_id: SEDE_B }]
        const res = await chiama({ id: CESTINATA_B }, ADMIN_A)
        expect(res.status).toBe(200)
        expect(mediaDi(CESTINATA_B)?.eliminato_il).toBeNull()
    })

    it('un id che non esiste è 404, non 403 e non 500', async () => {
        const res = await chiama({ id: MAI_ESISTITA }, SEGR_A)
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ codice: 'GALLERIA_MEDIA_NON_TROVATO' })
    })
})

describe('POST /api/gallery/ripristina — che cosa NON si ripristina', () => {
    it('una foto VIVA è 409 `MEDIA_NON_RIPRISTINABILE`, e non un 200 «già fatto»', async () => {
        const res = await chiama({ id: VIVA_A }, SEGR_A)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'MEDIA_NON_RIPRISTINABILE' })
        // Nessuna scrittura: il 409 arriva prima dell'UPDATE.
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        expect(evento('non-era-nel-cestino')).toBeDefined()
    })

    it('una foto il cui FILE è già stato distrutto è 409: ripristinarla darebbe una foto rotta', async () => {
        const res = await chiama({ id: PURGATA_A }, SEGR_A)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'MEDIA_NON_RIPRISTINABILE' })
        expect(mediaDi(PURGATA_A)?.eliminato_il).toBe(QUARANTA_GIORNI_FA)
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        // L'`esito` distingue i due stati che condividono il codice HTTP: è lì che
        // guarda chi deve capire cosa è successo.
        expect(evento('file-gia-rimosso')).toBeDefined()
    })

    /**
     * IL 409 ARRIVA DOPO IL GATE DI SEDE, e non è un dettaglio d'ordine: dato
     * prima sarebbe un oracolo — chiunque, con un uuid, saprebbe che quella foto
     * esiste e che qualcuno l'ha eliminata. Chi non ne ha titolo prende 403.
     */
    it('la foto VIVA di un altro plesso è 403, non 409: il 409 non è un oracolo', async () => {
        const altrove = mediaDi(CESTINATA_B)!
        altrove.eliminato_il = null
        altrove.eliminato_da = null
        const res = await chiama({ id: CESTINATA_B }, SEGR_A)
        expect(res.status).toBe(403)
    })
})

describe('POST /api/gallery/ripristina — il caso felice', () => {
    it('azzera `eliminato_il` ED `eliminato_da`, e risponde 200', async () => {
        const res = await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ success: true, esito: 'ripristinato' })

        const riga = mediaDi(CESTINATA_A)!
        expect(riga.eliminato_il).toBeNull()
        // ⚠️ Anche `eliminato_da`: lasciandolo, la riga direbbe per sempre che
        // qualcuno l'ha eliminata mentre è viva in galleria.
        expect(riga.eliminato_da).toBeNull()

        const su = scrittureSu('galleria_media_v2')
        expect(su).toHaveLength(1)
        expect(su[0].op).toBe('update')
        expect(su[0].patch).toEqual({ eliminato_il: null, eliminato_da: null })
        expect(su[0].toccate).toBe(1)
    })

    it('non tocca nessun’altra riga: né le vive, né quelle di un altro plesso', async () => {
        await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(mediaDi(CESTINATA_B)?.eliminato_il).toBe(TRE_GIORNI_FA)
        expect(mediaDi(PURGATA_A)?.eliminato_il).toBe(QUARANTA_GIORNI_FA)
        expect(mediaDi(VIVA_A)?.eliminato_il).toBeNull()
    })

    it('scrive l’AUDIT: `galleria_media`, azione `update`, con la sede del media', async () => {
        await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(audit()).toHaveLength(1)
        expect(audit()[0].patch).toMatchObject({
            attore_id: SEGR_A,
            entita_tipo: 'galleria_media',
            entita_id: CESTINATA_A,
            azione: 'update',
            scuola_id: SEDE_A,
        })
    })

    it('logga il SUCCESSO con la sede, i giorni nel cestino e il ruolo', async () => {
        await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(evento('ripristinato')).toMatchObject({
            operazione: 'gallery/ripristina:POST',
            esito: 'ripristinato',
            sede_id: SEDE_A,
            giorni_nel_cestino: 3,
            ruolo_attore: 'segreteria',
        })
    })

    /**
     * ⚠️ LA DIDASCALIA. In produzione è il nome del file scelto da chi carica, e
     * nella pratica di questa scuola è il nome di un bambino. La rotta non la legge
     * nemmeno (`select` nomina quattro colonne), ed è la prima difesa: un dato che
     * non si legge non può finire in un log per distrazione. Questa prova misura il
     * risultato in tutti e tre i posti da cui potrebbe uscire.
     */
    it('non fa uscire la didascalia: né nei log, né nell’audit, né nella risposta', async () => {
        const res = await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(await res.text()).not.toContain(DIDASCALIA)
        expect(tuttiILog()).not.toContain(DIDASCALIA)
        expect(JSON.stringify(h.scritture)).not.toContain(DIDASCALIA)
    })

    /**
     * Un ripristino oltre i 30 giorni di grazia significa che la PURGA non ha
     * girato: quel file doveva già essere stato distrutto, e chi l'ha ripescato ha
     * recuperato qualcosa che il sistema aveva promesso di non avere più. È un
     * `warn`, quindi finisce in tabella.
     */
    it('un ripristino oltre i 30 giorni accende un `warn`: la purga non ha girato', async () => {
        const vecchia = mediaDi(PURGATA_A)!
        vecchia.file_rimosso_il = null // nel cestino da 40 giorni, ma il file c'è ancora
        const res = await chiama({ id: PURGATA_A }, SEGR_A)
        expect(res.status).toBe(200)
        const riga = eventi().find(
            (c) => (c[2] as { esito?: string } | undefined)?.esito === 'ripristino-oltre-la-grazia',
        )
        expect(riga).toBeDefined()
        expect(riga?.[1]).toBe('warn')
        expect(riga?.[2]).toMatchObject({ giorni_nel_cestino: 40, giorni_di_grazia: 30 })
    })

    it('un ripristino DENTRO i 30 giorni non accende nessun warn', async () => {
        await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(eventi().map((c) => c[1])).not.toContain('warn')
    })
})

describe('POST /api/gallery/ripristina — la corsa fra due impiegate', () => {
    /**
     * LA CONDIZIONE CHE DECIDE LA CORSA STA DENTRO L'UPDATE, non nel controllo di
     * stato: fra la lettura e la scrittura passa il tempo di una query, e in quella
     * finestra l'altra impiegata può aver già premuto Ripristina. Qui la riga viene
     * riportata in vita nell'istante esatto fra le due, e la rotta deve accorgersene
     * dalle ZERO righe toccate.
     *
     * ⚠️ CONTROPROVA ESEGUITA: togliendo `soloNelCestino` dall'UPDATE la scrittura
     * tocca la riga comunque, la rotta risponde 200 e questa prova diventa rossa.
     */
    it('chi arriva secondo riceve 409, non un finto successo', async () => {
        h.primaDellUpdate = () => {
            const riga = mediaDi(CESTINATA_A)!
            riga.eliminato_il = null
            riga.eliminato_da = null
        }
        const res = await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'MEDIA_NON_RIPRISTINABILE' })
        expect(evento('corsa-persa')).toBeDefined()
        // Nessun audit: non è avvenuta nessuna scrittura da registrare.
        expect(audit()).toEqual([])
    })
})

describe('POST /api/gallery/ripristina — il DB E2E della CI, che non è migrato', () => {
    /**
     * ⚠️ 42703 NON DEVE PRODURRE UN 500. Il DB E2E della CI è un progetto separato
     * e non migrato: là le tre colonne del cestino non esistono. Un 500 direbbe
     * «guasto nostro» su una funzione che su quell'impianto non c'è, e la CI si
     * spegnerebbe su un difetto che non è un difetto.
     */
    it('la LETTURA che nomina le colonne del cestino risponde 501, non 500', async () => {
        h.erroreLetturaCestino = '42703'
        const res = await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(res.status).toBe(501)
        expect(await res.json()).toMatchObject({ codice: 'GALLERIA_RIPRISTINO_NON_DISPONIBILE' })
        // E soprattutto: NIENTE è stato scritto.
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        expect(audit()).toEqual([])
        expect(evento('cestino-colonna-assente')).toBeDefined()
    })

    /**
     * `PGRST204` sulla SCRITTURA è lo stesso guasto visto dall'altro lato, e non è
     * un ramo morto: la cache dello schema di PostgREST può non conoscere ancora una
     * colonna che la SELECT trova già (è il minuto dopo una migrazione).
     */
    it('la SCRITTURA respinta con `PGRST204` risponde 501, e la riga resta nel cestino', async () => {
        h.erroreScritturaCestino = 'PGRST204'
        const res = await chiama({ id: CESTINATA_A }, SEGR_A)
        expect(res.status).toBe(501)
        expect(await res.json()).toMatchObject({ codice: 'GALLERIA_RIPRISTINO_NON_DISPONIBILE' })
        expect(mediaDi(CESTINATA_A)?.eliminato_il).toBe(TRE_GIORNI_FA)
        expect(audit()).toEqual([])
    })

    /**
     * IL CONTROLLO POSITIVO DEL FINTO DATABASE. Senza questo, tutte le prove qui
     * sopra sarebbero verdi anche con un finto database che non applica NIENTE:
     * «nessun errore» e «nessun controllo» hanno lo stesso colore.
     */
    it('il finto database dice `42703` solo alle query che nominano il cestino', async () => {
        h.erroreLetturaCestino = '42703'
        const q = adminClient.from('galleria_media_v2') as unknown as {
            select: (c: string) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { code: string } | null }> }
        }
        const senzaCestino = await q.select('id, scuola_id').eq('id', CESTINATA_A)
        expect(senzaCestino.error).toBeNull()

        const q2 = adminClient.from('galleria_media_v2') as unknown as {
            select: (c: string) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { code: string } | null }> }
        }
        const conCestino = await q2.select('id, eliminato_il').eq('id', CESTINATA_A)
        expect(conCestino.error).toEqual({ code: '42703' })
    })
})
