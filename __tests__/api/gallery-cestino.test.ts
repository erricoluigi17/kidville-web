import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
 * IL CESTINO DELLA GALLERIA — `DELETE` nasconde, `GET ?stato=cestino` elenca
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * Fino al 2026-09-11 `DELETE /api/gallery?id=…` faceva `.delete()` sulla riga e
 * **non toccava lo Storage**: il file restava nel bucket per sempre, senza più
 * nessuna riga che lo nominasse. Su una galleria di scuola dell'infanzia questo
 * significa due cose insieme: un tocco sbagliato di un'insegnante cancella per
 * sempre la foto di un pomeriggio che non si ripete, e la foto di un minore
 * diventa un oggetto irraggiungibile e incancellabile nell'archivio.
 *
 * Adesso «Elimina» è un'ARCHIVIAZIONE: `eliminato_il` + `eliminato_da`, la foto
 * spariscre subito dalla vista di tutti (genitori compresi, per la policy RLS
 * della migrazione `20260911214752`), e resta recuperabile 30 giorni.
 *
 * ─── LE QUATTRO COSE CHE QUESTO FILE PROVA, E NON ARGOMENTA ─────────────────
 *   1. la DELETE **non chiama `.delete()`**: chiama `.update()` coi due campi.
 *      È la prova che il file nel bucket non resta orfano — e non è un'opinione
 *      sul codice, è il registro delle operazioni fatte sul finto database;
 *   2. la SECONDA DELETE risponde `gia-eliminato` e non un errore: due persone
 *      della segreteria che premono insieme sono la normalità di una scuola;
 *   3. l'audit c'è (`audit_scritture_docente`) e il log di SUCCESSO c'è —
 *      **senza la didascalia**, che in questa scuola è il nome del file, cioè
 *      spesso il nome di un bambino;
 *   4. il degrado su `42703` non spegne la galleria, e **non spegne per errore
 *      l'isolamento di sede**: i due degradi hanno lo stesso codice PostgREST e
 *      distinguerli a indovinare costa una falla in un verso o nell'altro.
 *
 * ⚠️ IL FINTO DATABASE APPLICA I FILTRI DAVVERO — `.is()`, `.not()`, `.lt()`,
 * `.in()`, `.contains()`, l'ordinamento, `.range()`, e le mutazioni di
 * `.update()`. Un mock piatto sarebbe verde con la correzione e senza: in questo
 * repo è già successo (13.254 test verdi e il difetto vivo in produzione).
 * La controprova è stata ESEGUITA, non promessa: rimettendo `.delete()` nella
 * route, otto prove di questo file diventano rosse.
 *
 * ⚠️ NIENTE DATI VERI. Gli uuid, i nomi e le didascalie qui dentro sono
 * inventati: in produzione ci sono anagrafiche di minori e questo repository è
 * pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

// uuid validi (z.guid: 8-4-4-4-12), tutti inventati.
const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SEGR_A = '5e9e0000-0000-4000-8000-00000000000a'
const EDU_A = 'edu00000-0000-4000-8000-00000000000a'
const ALU_A1 = 'a1a1a1a1-1111-4111-8111-111111111111'
const ALU_B1 = 'b1b1b1b1-3333-4333-8333-333333333333'
const FOTO_A = 'f0100000-0000-4000-8000-000000000001'
const FOTO_A2 = 'f0100000-0000-4000-8000-000000000002'
const FOTO_B = 'f0200000-0000-4000-8000-00000000000b'
const CESTINATA = 'c0300000-0000-4000-8000-000000000003'
const PURGATA = 'c0300000-0000-4000-8000-000000000004'

/**
 * La didascalia è il campo che non deve MAI comparire in un log. In produzione
 * la didascalia della galleria è il nome del file scelto da chi carica, e nella
 * pratica di questa scuola è «<nome> al parco.jpg»: il nome di un bambino.
 * Qui è una stringa inventata e riconoscibile, così cercarla nei log è una
 * misura e non un'impressione.
 */
const DIDASCALIA = 'PAROLA-CHE-NON-DEVE-FINIRE-NEI-LOG'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    requireDocente: vi.fn(),
    requireParentOfStudent: vi.fn(),
    logEvento: vi.fn(),
    // Lo stato del finto database, riscritto in `beforeEach`.
    media: [] as Array<Record<string, unknown>>,
    alunni: [] as Array<Record<string, unknown>>,
    sections: [] as Array<Record<string, unknown>>,
    utenti: [] as Array<Record<string, unknown>>,
    utentiScuole: [] as Array<Record<string, unknown>>,
    schools: [] as Array<Record<string, unknown>>,
    notifiche: [] as Array<Record<string, unknown>>,
    /** Ogni operazione di SCRITTURA eseguita, in ordine. L'unica prova che conta. */
    scritture: [] as Array<{ tabella: string; op: 'insert' | 'update' | 'delete'; patch?: Riga; toccate?: number }>,
    /** Codice PostgREST per le query che nominano una colonna del CESTINO. */
    erroreCestino: null as string | null,
    /** Codice PostgREST per le query che filtrano per `scuola_id`. */
    erroreSede: null as string | null,
}))

// I gate: le identità si iniettano, il resto della route è reale.
vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: h.requireStaff,
    requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))

// ⚠️ `@/lib/gallery/cestino` NON è mockato: `soloVive`/`soloNelCestino` sono
// quelli veri, quindi la condizione che finisce nella query la decide il codice
// di produzione e non questo file. Mockarli renderebbe verde una route che ha
// dimenticato il filtro — cioè esattamente il difetto da cui questo file guarda.
// Stessa cosa per `@/lib/audit/scrittura`: l'audit si verifica sulla RIGA
// scritta, non sulla chiamata, perché `logScrittura` scarta gli `entita_id` che
// non sono uuid e una riga mai scritta è già capitata in questo repo.
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: h.logEvento,
}))

// ─────────────────────────────────────────────────────────────────────────────
// Il finto PostgREST — piccolo, ma esegue davvero i filtri e le mutazioni.
// ─────────────────────────────────────────────────────────────────────────────
type Stato = {
    tabella: string
    op: 'select' | 'insert' | 'update' | 'delete'
    patch: Riga | null
    head: boolean
    eq: Array<[string, unknown]>
    dentro: Array<[string, unknown[]]>
    contiene: Array<[string, unknown[]]>
    gte: Array<[string, string]>
    lte: Array<[string, string]>
    lt: Array<[string, string]>
    is: Array<[string, boolean | null]>
    non: Array<[string, string, unknown]>
    or: string[]
    ordine: Array<{ col: string; asc: boolean }>
}

/** Spezza `a,and(b,c),d` sulle virgole di PRIMO livello. */
function pezzi(s: string): string[] {
    const out: string[] = []
    let prof = 0
    let corrente = ''
    for (const ch of s) {
        if (ch === '(' || ch === '{') prof++
        else if (ch === ')' || ch === '}') prof--
        if (ch === ',' && prof === 0) {
            out.push(corrente)
            corrente = ''
            continue
        }
        corrente += ch
    }
    if (corrente) out.push(corrente)
    return out
}

/** Gli elementi di `{a,b}` / `{"NOME"}`. */
function insieme(s: string): string[] {
    return s
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((v) => v.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)
}

/** Valuta una condizione PostgREST come quelle che costruisce la route. */
function condizione(riga: Riga, cond: string): boolean {
    const c = cond.trim()
    if (c.startsWith('and(')) {
        return pezzi(c.slice(4, -1)).every((sub) => condizione(riga, sub))
    }
    const m = /^([a-z_]+)\.(eq|cs|ov|is)\.(.*)$/.exec(c)
    if (!m) throw new Error(`condizione non emulata dal finto DB: ${c}`)
    const [, col, op, val] = m
    const v = riga[col]
    if (op === 'eq') return String(v) === val
    if (op === 'is') return val === 'null' ? v === null || v === undefined : String(v) === val
    const attesi = insieme(val)
    const presenti = Array.isArray(v) ? (v as unknown[]).map(String) : []
    if (op === 'cs') return attesi.every((a) => presenti.includes(a))
    return attesi.some((a) => presenti.includes(a)) // ov
}

function righeDi(tabella: string): Riga[] {
    if (tabella === 'galleria_media_v2') return h.media
    if (tabella === 'alunni') return h.alunni
    if (tabella === 'sections') return h.sections
    if (tabella === 'utenti') return h.utenti
    if (tabella === 'utenti_scuole') return h.utentiScuole
    if (tabella === 'schools') return h.schools
    if (tabella === 'notifiche') return h.notifiche
    return []
}

/**
 * Le colonne che su un database NON migrato non esistono. `erroreCestino` scatta
 * SOLO se la query le nomina: è ciò che rende il degrado una misura invece di
 * un'asserzione — una query che non le nomina deve continuare a funzionare, e
 * l'isolamento di sede non deve cadere insieme a loro.
 */
const COLONNE_CESTINO = new Set(['eliminato_il', 'eliminato_da', 'file_rimosso_il'])

function nominaIlCestino(s: Stato): boolean {
    return (
        s.is.some(([c]) => COLONNE_CESTINO.has(c)) ||
        s.non.some(([c]) => COLONNE_CESTINO.has(c)) ||
        s.lt.some(([c]) => COLONNE_CESTINO.has(c)) ||
        s.ordine.some(({ col }) => COLONNE_CESTINO.has(col)) ||
        Object.keys(s.patch ?? {}).some((c) => COLONNE_CESTINO.has(c))
    )
}

function filtra(s: Stato): Riga[] {
    let righe = righeDi(s.tabella).slice()
    for (const [col, val] of s.eq) righe = righe.filter((r) => r[col] === val)
    for (const [col, vals] of s.dentro) righe = righe.filter((r) => vals.includes(r[col] as never))
    for (const [col, vals] of s.contiene) {
        righe = righe.filter((r) => {
            const v = Array.isArray(r[col]) ? (r[col] as unknown[]).map(String) : []
            return vals.every((x) => v.includes(String(x)))
        })
    }
    for (const [col, val] of s.gte) righe = righe.filter((r) => String(r[col]) >= val)
    for (const [col, val] of s.lte) righe = righe.filter((r) => String(r[col]) <= val)
    for (const [col, val] of s.lt) righe = righe.filter((r) => String(r[col] ?? '') < val)
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
    // `.or()` chiamata più volte ⇒ le condizioni si sommano in AND (come PostgREST).
    for (const espressione of s.or) {
        righe = righe.filter((r) => pezzi(espressione).some((c) => condizione(r, c)))
    }
    for (const { col, asc } of [...s.ordine].reverse()) {
        righe.sort((x, y) => {
            const a = String(x[col] ?? '')
            const b = String(y[col] ?? '')
            return asc ? a.localeCompare(b) : b.localeCompare(a)
        })
    }
    return righe
}

/** L'errore da restituire a questa query, se l'impianto non ha le colonne. */
function erroreDi(s: Stato): { code: string } | null {
    if (h.erroreCestino && nominaIlCestino(s)) return { code: h.erroreCestino }
    if (h.erroreSede && (s.dentro.some(([c]) => c === 'scuola_id') || 'scuola_id' in (s.patch ?? {}))) {
        return { code: h.erroreSede }
    }
    return null
}

/** Esegue la query/mutazione e restituisce la risposta PostgREST. */
function esegui(s: Stato): { data: Riga[] | null; count: number | null; error: { code: string } | null } {
    const err = erroreDi(s)
    if (err) return { data: null, count: null, error: err }

    if (s.op === 'insert') {
        const riga = { id: `nuovo-${h.scritture.length}`, ...(s.patch ?? {}) }
        righeDi(s.tabella).push(riga)
        h.scritture.push({ tabella: s.tabella, op: 'insert', patch: s.patch ?? {} })
        return { data: [riga], count: 1, error: null }
    }

    const colpite = filtra(s)

    if (s.op === 'update') {
        for (const r of colpite) Object.assign(r, s.patch ?? {})
        h.scritture.push({ tabella: s.tabella, op: 'update', patch: s.patch ?? {}, toccate: colpite.length })
        return { data: colpite, count: colpite.length, error: null }
    }

    if (s.op === 'delete') {
        const tavolo = righeDi(s.tabella)
        for (const r of colpite) {
            const i = tavolo.indexOf(r)
            if (i >= 0) tavolo.splice(i, 1)
        }
        h.scritture.push({ tabella: s.tabella, op: 'delete', toccate: colpite.length })
        return { data: colpite, count: colpite.length, error: null }
    }

    // `head: true` è il conteggio senza righe (`select('id', { count, head })`).
    return { data: s.head ? null : colpite, count: colpite.length, error: null }
}

const adminClient = {
    from(tabella: string) {
        const s: Stato = {
            tabella, op: 'select', patch: null, head: false,
            eq: [], dentro: [], contiene: [], gte: [], lte: [], lt: [], is: [], non: [],
            or: [], ordine: [],
        }
        const b: Record<string, unknown> = {}
        b.select = (_cols?: string, opt?: { head?: boolean }) => {
            if (opt?.head) s.head = true
            return b
        }
        b.insert = (row: Riga) => {
            s.op = 'insert'
            s.patch = row
            return b
        }
        b.update = (row: Riga) => {
            s.op = 'update'
            s.patch = row
            return b
        }
        b.delete = () => {
            s.op = 'delete'
            return b
        }
        b.eq = (col: string, val: unknown) => { s.eq.push([col, val]); return b }
        b.in = (col: string, vals: unknown[]) => { s.dentro.push([col, vals]); return b }
        b.contains = (col: string, vals: unknown[]) => { s.contiene.push([col, vals]); return b }
        b.gte = (col: string, val: string) => { s.gte.push([col, val]); return b }
        b.lte = (col: string, val: string) => { s.lte.push([col, val]); return b }
        b.lt = (col: string, val: string) => { s.lt.push([col, val]); return b }
        b.is = (col: string, val: boolean | null) => { s.is.push([col, val]); return b }
        b.not = (col: string, op: string, val: unknown) => { s.non.push([col, op, val]); return b }
        b.or = (espressione: string) => { s.or.push(espressione); return b }
        b.order = (col: string, opt?: { ascending?: boolean }) => {
            s.ordine.push({ col, asc: opt?.ascending !== false })
            return b
        }
        b.range = async (da: number, a: number) => {
            const r = esegui(s)
            if (r.error) return r
            return { data: (r.data ?? []).slice(da, a + 1), count: r.count, error: null }
        }
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
    storage: {
        from: () => ({
            createSignedUrls: async (percorsi: string[]) => ({
                data: percorsi.map((p) => ({ path: p, signedUrl: `https://firmato.test/${p}`, error: null })),
                error: null,
            }),
        }),
    },
}

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => adminClient,
}))

import { DELETE, GET, PATCH } from '@/app/api/gallery/route'

const getReq = (qs: string) => new Request(`http://localhost/api/gallery${qs ? `?${qs}` : ''}`)
const delReq = (qs: string) => new Request(`http://localhost/api/gallery?${qs}`, { method: 'DELETE' })
const patchReq = (body: unknown) => new Request('http://localhost/api/gallery', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
})

const SEGRETERIA_A = { id: SEGR_A, role: 'segreteria', scuola_id: SEDE_A }
const MAESTRA_A = { id: EDU_A, role: 'educator', scuola_id: SEDE_A }

const eventi = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')
const esiti = () => eventi().map((c) => (c[2] as { esito?: string } | undefined)?.esito)
const evento = (esito: string) =>
    eventi().find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)?.[2] as Riga | undefined
/** Tutte le chiamate a log, qualunque canale: serve a cercare la didascalia. */
const tuttiILog = () => JSON.stringify(h.logEvento.mock.calls)

const scrittureSu = (tabella: string) => h.scritture.filter((w) => w.tabella === tabella)
const audit = () => h.scritture.filter((w) => w.tabella === 'audit_scritture_docente')

beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { ...SEGRETERIA_A } })
    h.requireDocente.mockResolvedValue({ user: { ...SEGRETERIA_A } })
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
    h.erroreCestino = null
    h.erroreSede = null
    h.scritture = []
    h.schools = [{ id: SEDE_A }, { id: SEDE_B }]
    h.utentiScuole = []
    h.utenti = [
        // `ruolo` (non `role`: è una colonna GENERATA) è ciò che la route legge
        // per decidere l'autorizzazione.
        { id: SEGR_A, ruolo: 'segreteria', scuola_id: SEDE_A, nome: 'Anna', cognome: 'Inventata', first_name: null, last_name: null },
        { id: EDU_A, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Maestra', cognome: 'Inventata', first_name: null, last_name: null },
    ]
    h.sections = []
    h.alunni = [
        { id: ALU_A1, nome: 'Primo', cognome: 'Della A', classe_sezione: 'GIRASOLI', section_id: null, scuola_id: SEDE_A },
        { id: ALU_B1, nome: 'Unico', cognome: 'Della B', classe_sezione: 'GIRASOLI', section_id: null, scuola_id: SEDE_B },
    ]
    h.media = [
        {
            id: FOTO_A, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/1.jpg',
            file_type: 'foto', caption: DIDASCALIA, tag_students: [ALU_A1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-01T08:00:00.000Z',
            eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
        },
        {
            id: FOTO_A2, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/2.jpg',
            file_type: 'foto', caption: null, tag_students: [], is_broadcast: true,
            target_classes: null, created_at: '2026-09-04T08:00:00.000Z',
            eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
        },
        {
            id: FOTO_B, scuola_id: SEDE_B, uploaded_by: 'ed-b', file_url: 'uploads/b/1.jpg',
            file_type: 'foto', caption: null, tag_students: [ALU_B1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-05T08:00:00.000Z',
            eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
        },
        {
            // Già nel cestino, e ripristinabile (il file c'è ancora).
            id: CESTINATA, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/3.jpg',
            file_type: 'foto', caption: null, tag_students: [], is_broadcast: false,
            target_classes: null, created_at: '2026-09-02T08:00:00.000Z',
            eliminato_il: '2026-09-10T10:00:00.000Z', eliminato_da: SEGR_A, file_rimosso_il: null,
        },
        {
            // Nel cestino E già purgata dallo Storage: non è più ripristinabile,
            // quindi non deve comparire nel cestino.
            id: PURGATA, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/4.jpg',
            file_type: 'foto', caption: null, tag_students: [], is_broadcast: false,
            target_classes: null, created_at: '2026-08-01T08:00:00.000Z',
            eliminato_il: '2026-08-02T10:00:00.000Z', eliminato_da: SEGR_A,
            file_rimosso_il: '2026-09-01T10:00:00.000Z',
        },
    ]
    h.notifiche = [
        // Due in volo per l'insegnante che ha caricato `FOTO_A`.
        { id: 'n1', tipo: 'galleria', entita_id: EDU_A, utente_id: 'g1', push_inviata_il: null },
        { id: 'n2', tipo: 'galleria', entita_id: EDU_A, utente_id: 'g2', push_inviata_il: null },
        // Una già spedita: non è più «pendente».
        { id: 'n3', tipo: 'galleria', entita_id: EDU_A, utente_id: 'g3', push_inviata_il: '2026-09-10T09:00:00.000Z' },
        // Di un altro insegnante, e di un altro tipo: non contano.
        { id: 'n4', tipo: 'galleria', entita_id: 'ed-b', utente_id: 'g4', push_inviata_il: null },
        { id: 'n5', tipo: 'avviso', entita_id: EDU_A, utente_id: 'g5', push_inviata_il: null },
    ]
})

/* ────────────────────────────────────────────────────────────────────────────
 * (A) «ELIMINA» NON CANCELLA PIÙ — la prova sul registro delle operazioni
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(A) DELETE: archivia, non distrugge', () => {
    it('NON esegue nessun `.delete()` su galleria_media_v2', async () => {
        const res = await DELETE(delReq(`id=${FOTO_A}`))
        expect(res.status).toBe(200)
        expect(
            scrittureSu('galleria_media_v2').filter((w) => w.op === 'delete'),
            'la riga è stata cancellata: il file resta nel bucket senza più nessuna riga che lo nomini',
        ).toEqual([])
    })

    it('esegue un `.update()` con `eliminato_il` e `eliminato_da`', async () => {
        const res = await DELETE(delReq(`id=${FOTO_A}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ success: true, esito: 'nel-cestino' })

        const aggiornamenti = scrittureSu('galleria_media_v2').filter((w) => w.op === 'update')
        expect(aggiornamenti).toHaveLength(1)
        const patch = aggiornamenti[0].patch as { eliminato_il?: string; eliminato_da?: string }
        // `eliminato_da` è l'utente del GATE, non il `?userId=` della query.
        expect(patch.eliminato_da).toBe(SEGR_A)
        expect(typeof patch.eliminato_il).toBe('string')
        expect(new Date(patch.eliminato_il as string).toString()).not.toBe('Invalid Date')
        // …e ha toccato UNA riga: quella, non tutta la sede.
        expect(aggiornamenti[0].toccate).toBe(1)
    })

    it('l\'identità viene dal gate: un `?userId=` arbitrario non finisce in `eliminato_da`', async () => {
        await DELETE(delReq(`id=${FOTO_A}&userId=${EDU_A}`))
        const patch = scrittureSu('galleria_media_v2')
            .find((w) => w.op === 'update')?.patch as { eliminato_da?: string }
        expect(patch.eliminato_da).toBe(SEGR_A)
    })

    it('lo Storage non si tocca: il file resta nel bucket per la purga', async () => {
        // `file_url` è ancora sulla riga, e `file_rimosso_il` resta NULL: sono le
        // due cose che permettono alla purga di trovare il file fra 30 giorni.
        await DELETE(delReq(`id=${FOTO_A}`))
        const riga = h.media.find((m) => m.id === FOTO_A)!
        expect(riga.file_url).toBe('uploads/a/1.jpg')
        expect(riga.file_rimosso_il).toBeNull()
    })

    it('le `segnalazioni` non vengono toccate: sono la RAGIONE della rimozione', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        expect(scrittureSu('segnalazioni')).toEqual([])
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (B) DUE PERSONE CHE PREMONO INSIEME
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(B) idempotenza: `gia-eliminato` non è un errore', () => {
    it('la SECONDA DELETE risponde 200 `gia-eliminato`, non 404 né 500', async () => {
        const primo = await DELETE(delReq(`id=${FOTO_A}`))
        expect(await primo.json()).toEqual({ success: true, esito: 'nel-cestino' })

        const secondo = await DELETE(delReq(`id=${FOTO_A}`))
        expect(secondo.status).toBe(200)
        expect(await secondo.json()).toEqual({ success: true, esito: 'gia-eliminato' })
        expect(esiti()).toContain('gia-eliminato')
    })

    it('la seconda DELETE non riscrive `eliminato_il` (i 30 giorni non ripartono)', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        const quando = h.media.find((m) => m.id === FOTO_A)!.eliminato_il
        h.scritture = []
        await DELETE(delReq(`id=${FOTO_A}`))
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        expect(h.media.find((m) => m.id === FOTO_A)!.eliminato_il).toBe(quando)
    })

    it('una riga già nel cestino risponde `gia-eliminato` e non 404 (`Media non trovato`)', async () => {
        const res = await DELETE(delReq(`id=${CESTINATA}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ success: true, esito: 'gia-eliminato' })
    })

    it('`gia-eliminato` non è un oracolo: fuori dalla propria sede resta 403', async () => {
        // La foto di B è VIVA, ma la segreteria di A non deve poter distinguere
        // «non è tua» da «era già eliminata»: il gate di sede viene prima.
        h.media.find((m) => m.id === FOTO_B)!.eliminato_il = '2026-09-10T10:00:00.000Z'
        const res = await DELETE(delReq(`id=${FOTO_B}`))
        expect(res.status).toBe(403)
        expect(esiti()).toContain('media-fuori-sede')
        expect(esiti()).not.toContain('gia-eliminato')
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (C) L'AUDIT E IL LOG DI SUCCESSO
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(C) chi ha eliminato cosa, e quando', () => {
    it('scrive la riga in `audit_scritture_docente` — con un `entita_id` uuid vero', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        expect(audit()).toHaveLength(1)
        const riga = audit()[0].patch as Riga
        expect(riga.entita_tipo).toBe('galleria_media')
        // ⚠️ `logScrittura` scarta gli `entita_id` che non sono uuid (li sposta
        // nel valore, con un `warn`): se qui arrivasse una chiave composta la
        // riga di audit resterebbe senza il riferimento alla foto.
        expect(riga.entita_id).toBe(FOTO_A)
        expect(riga.azione).toBe('delete')
        expect(riga.attore_id).toBe(SEGR_A)
        // La sede è quella DEL MEDIA, non la sede primaria di chi opera.
        expect(riga.scuola_id).toBe(SEDE_A)
    })

    it('logga il SUCCESSO con conteggi, uuid e flag', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        const riga = evento('nel-cestino')
        expect(riga, 'senza il log di successo «nessun log» non distingue «nel cestino» da «non è mai partito niente»').toBeDefined()
        expect(riga).toMatchObject({
            operazione: 'gallery:DELETE',
            esito: 'nel-cestino',
            sede_id: SEDE_A,
            ruolo_attore: 'segreteria',
            era_broadcast: false,
            n_tag: 1,
        })
    })

    it('`n_notifiche_pendenti` conta le notifiche in volo dell\'INSEGNANTE, e non le cancella', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        // Due in volo per `EDU_A`: la spedita, quella di un altro insegnante e
        // quella di un altro tipo restano fuori.
        expect(evento('nel-cestino')).toMatchObject({ n_notifiche_pendenti: 2 })
        // ⚠️ NON si ritirano: `entitaId` delle notifiche è l'uploader, cioè la
        // chiave del debounce per insegnante corretta dopo le 168 notifiche
        // perse. Cambiarla nell'id del media farebbe 37 notifiche per famiglia.
        expect(scrittureSu('notifiche')).toEqual([])
        expect(h.notifiche).toHaveLength(5)
    })

    it('un broadcast senza tag si logga come tale', async () => {
        await DELETE(delReq(`id=${FOTO_A2}`))
        expect(evento('nel-cestino')).toMatchObject({ era_broadcast: true, n_tag: 0 })
    })

    it('⚠️ LA DIDASCALIA NON COMPARE IN NESSUN LOG — è il nome del file, e spesso di un bambino', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        expect(h.media.find((m) => m.id === FOTO_A)!.caption).toBe(DIDASCALIA)
        expect(
            tuttiILog(),
            'la didascalia di una foto è il nome del file: in produzione contiene il nome del bambino',
        ).not.toContain(DIDASCALIA)
    })

    it('nessun log porta l\'uuid di un BAMBINO taggato', async () => {
        await DELETE(delReq(`id=${FOTO_A}`))
        expect(tuttiILog()).not.toContain(ALU_A1)
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (D) LA GET IMPARA `stato`
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(D) GET ?stato=', () => {
    it('la vista normale NON mostra le foto nel cestino', async () => {
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
        expect(ids.sort()).toEqual([FOTO_A, FOTO_A2].sort())
        expect(ids, 'una foto eliminata è tornata nella galleria').not.toContain(CESTINATA)
        expect(j.total).toBe(2)
    })

    it('`stato=cestino` mostra SOLO le foto nel cestino, coi due campi', async () => {
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        expect(res.status).toBe(200)
        const j = await res.json()
        const righe = j.media as Array<Riga>
        expect(righe.map((r) => r.id)).toEqual([CESTINATA])
        expect(righe[0].eliminato_il).toBe('2026-09-10T10:00:00.000Z')
        expect(righe[0].eliminato_da).toBe(SEGR_A)
    })

    it('il cestino NON offre ciò che non si può più ripristinare (`file_rimosso_il`)', async () => {
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        const j = await res.json()
        expect(
            (j.media as Array<{ id: string }>).map((m) => m.id),
            'una riga il cui file è già stato purgato offrirebbe un «Ripristina» che restituisce una foto rotta',
        ).not.toContain(PURGATA)
    })

    it('l\'ordine del cestino è per `eliminato_il` DISCENDENTE', async () => {
        h.media.push({
            id: 'c0300000-0000-4000-8000-000000000009', scuola_id: SEDE_A, uploaded_by: EDU_A,
            file_url: 'uploads/a/9.jpg', file_type: 'foto', caption: null, tag_students: [],
            is_broadcast: false, target_classes: null,
            // Scattata PRIMA, eliminata DOPO: con l'ordine per `created_at`
            // finirebbe in fondo, ed è quella che la segreteria ha appena buttato.
            created_at: '2026-08-15T08:00:00.000Z',
            eliminato_il: '2026-09-11T23:00:00.000Z', eliminato_da: SEGR_A, file_rimosso_il: null,
        })
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual([
            'c0300000-0000-4000-8000-000000000009',
            CESTINATA,
        ])
    })

    it('il cestino resta dentro la SEDE: nessuna foto di un altro plesso', async () => {
        h.media.find((m) => m.id === FOTO_B)!.eliminato_il = '2026-09-11T10:00:00.000Z'
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).not.toContain(FOTO_B)
    })

    it('`stato=cestino` SENZA `scope=sede` è rifiutato (400), e non arriva al database', async () => {
        const res = await GET(getReq('stato=cestino'))
        expect(res.status).toBe(400)
        expect(h.requireStaff).not.toHaveBeenCalled()
        expect(h.requireDocente).not.toHaveBeenCalled()
    })

    it('`stato=cestino` non si infila nemmeno dal ramo del GENITORE né da quello della CLASSE', async () => {
        for (const qs of [`studentId=${ALU_A1}&stato=cestino`, 'classe=GIRASOLI&stato=cestino']) {
            const res = await GET(getReq(qs))
            expect(res.status, qs).toBe(400)
        }
    })

    it('un `stato` inventato è un 400, non un ripiego silenzioso', async () => {
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=tutti`))
        expect(res.status).toBe(400)
    })

    it('la lettura del cestino lascia la sua riga di log', async () => {
        await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        expect(evento('vista-cestino')).toMatchObject({ stato: 'cestino', sede_id: SEDE_A, n: 1 })
    })

    it('la vista di FAMIGLIA non vede le foto cestinate', async () => {
        h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
        h.media.find((m) => m.id === FOTO_A)!.eliminato_il = '2026-09-11T10:00:00.000Z'
        const res = await GET(getReq(`studentId=${ALU_A1}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).not.toContain(FOTO_A)
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (E) IL DEGRADO — e la parte che conta: NON spegne l'isolamento di sede
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(E) DB E2E della CI non migrato: 42703 sulle colonne del cestino', () => {
    it('la galleria continua a servire i media (200), con un `warn`', async () => {
        h.erroreCestino = '42703'
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status, 'il filtro del cestino ha spento l\'intera galleria in CI').toBe(200)
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).length).toBeGreaterThan(0)
        expect(esiti()).toContain('degrado-cestino-colonna-assente')
    })

    it('⚠️ e NON degrada il filtro di SEDE: le foto dell\'altro plesso restano fuori', async () => {
        // I due degradi hanno lo stesso codice PostgREST (`42703`/`PGRST204`), che
        // dice «una colonna non c'è», mai QUALE. Indovinare qui significherebbe
        // rileggere senza filtro di sede — il fail-open peggiore di questa rotta.
        h.erroreCestino = '42703'
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}`))
        const j = await res.json()
        const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
        expect(ids, 'la foto di un altro plesso nella galleria della segreteria').not.toContain(FOTO_B)
        expect(esiti()).not.toContain('degrado-scuola-id-assente')
    })

    it('il CESTINO di un impianto senza cestino è VUOTO, non «tutte le foto vive»', async () => {
        h.erroreCestino = '42703'
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}&stato=cestino`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect(
            j.media,
            'la vista «eliminate» mostrava le foto VIVE: la segreteria premerebbe «Ripristina» su ciò che non ha buttato',
        ).toEqual([])
        expect(j.total).toBe(0)
        expect(esiti()).toContain('degrado-cestino-colonna-assente')
    })

    it('`PGRST204` vale come `42703`', async () => {
        h.erroreCestino = 'PGRST204'
        const res = await GET(getReq(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(200)
        expect(esiti()).toContain('degrado-cestino-colonna-assente')
    })

    it('la DELETE non degrada CANCELLANDO: 501 e un log `error`', async () => {
        h.erroreCestino = 'PGRST204'
        const res = await DELETE(delReq(`id=${FOTO_A}`))
        expect(res.status).toBe(501)
        expect(
            scrittureSu('galleria_media_v2').filter((w) => w.op === 'delete'),
            'il degrado ha distrutto la riga: il file del bucket è ora irraggiungibile per sempre',
        ).toEqual([])
        expect(esiti()).toContain('cestino-colonna-assente')
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (F) LA PATCH — una foto nel cestino non si ritagga
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(F) PATCH su una riga cestinata', () => {
    it('risponde 409 e non scrive niente', async () => {
        const res = await PATCH(patchReq({ id: CESTINATA, caption: 'nuova' }))
        expect(res.status).toBe(409)
        expect(scrittureSu('galleria_media_v2')).toEqual([])
        expect(esiti()).toContain('media-nel-cestino')
    })

    it('409 e non 404: la foto esiste, ed è ripristinabile per 30 giorni', async () => {
        const res = await PATCH(patchReq({ id: CESTINATA, tag_students: [] }))
        expect(res.status).not.toBe(404)
        expect(res.status).toBe(409)
    })

    it('nessun tag di un minore finisce su una riga cestinata', async () => {
        await PATCH(patchReq({ id: CESTINATA, tag_students: [ALU_A1] }))
        expect(h.media.find((m) => m.id === CESTINATA)!.tag_students).toEqual([])
    })

    it('una foto VIVA si modifica come prima (il 409 non è una porta chiusa a tutti)', async () => {
        const res = await PATCH(patchReq({ id: FOTO_A, caption: 'corretta' }))
        expect(res.status).toBe(200)
        expect(h.media.find((m) => m.id === FOTO_A)!.caption).toBe('corretta')
    })

    it('409 solo DOPO il gate di sede: la foto cestinata di un altro plesso resta 403', async () => {
        h.media.find((m) => m.id === FOTO_B)!.eliminato_il = '2026-09-10T10:00:00.000Z'
        const res = await PATCH(patchReq({ id: FOTO_B, caption: 'x' }))
        expect(res.status).toBe(403)
        expect(esiti()).not.toContain('media-nel-cestino')
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (G) I PERMESSI DELLA MAESTRA NON VENGONO DA UNA FOTO ELIMINATA
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(G) le classi del docente si deducono dai soli media VIVI', () => {
    it('un tag che vive solo su una foto CESTINATA non autorizza più niente', async () => {
        // La maestra non ha caricato `FOTO_A`; il suo unico media è nel cestino, e
        // taggava un bambino di GIRASOLI. Se quel tag continuasse a valere, da lì
        // dedurrebbe «GIRASOLI è mia classe» e potrebbe cancellare la foto di
        // un'altra — un permesso concesso da una riga che la scuola ha buttato.
        h.requireDocente.mockResolvedValue({ user: { ...MAESTRA_A } })
        h.media = [
            {
                id: FOTO_A, scuola_id: SEDE_A, uploaded_by: SEGR_A, file_url: 'uploads/a/1.jpg',
                file_type: 'foto', caption: null, tag_students: [ALU_A1], is_broadcast: false,
                target_classes: ['GIRASOLI'], created_at: '2026-09-01T08:00:00.000Z',
                eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
            },
            {
                id: CESTINATA, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/3.jpg',
                file_type: 'foto', caption: null, tag_students: [ALU_A1], is_broadcast: false,
                target_classes: null, created_at: '2026-09-02T08:00:00.000Z',
                eliminato_il: '2026-09-10T10:00:00.000Z', eliminato_da: SEGR_A, file_rimosso_il: null,
            },
        ]
        const res = await DELETE(delReq(`id=${FOTO_A}`))
        expect(res.status).toBe(403)
        expect(scrittureSu('galleria_media_v2').filter((w) => w.op === 'update')).toEqual([])
    })

    it('controprova: lo STESSO tag su una foto VIVA autorizza (il filtro non nega tutto)', async () => {
        h.requireDocente.mockResolvedValue({ user: { ...MAESTRA_A } })
        h.media = [
            {
                id: FOTO_A, scuola_id: SEDE_A, uploaded_by: SEGR_A, file_url: 'uploads/a/1.jpg',
                file_type: 'foto', caption: null, tag_students: [ALU_A1], is_broadcast: false,
                target_classes: ['GIRASOLI'], created_at: '2026-09-01T08:00:00.000Z',
                eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
            },
            {
                id: FOTO_A2, scuola_id: SEDE_A, uploaded_by: EDU_A, file_url: 'uploads/a/2.jpg',
                file_type: 'foto', caption: null, tag_students: [ALU_A1], is_broadcast: false,
                target_classes: null, created_at: '2026-09-02T08:00:00.000Z',
                eliminato_il: null, eliminato_da: null, file_rimosso_il: null,
            },
        ]
        const res = await DELETE(delReq(`id=${FOTO_A}`))
        expect(res.status).toBe(200)
        expect(evento('nel-cestino')).toMatchObject({ ruolo_attore: 'educator' })
    })
})
