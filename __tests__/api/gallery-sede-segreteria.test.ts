import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
 * LA GALLERIA DI UNA SEDE INTERA — `GET /api/gallery?scope=sede&scuolaId=…`
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * Fino a oggi `GET /api/gallery` rispondeva **400** a chi non nominava né una
 * classe né un bambino, e non era una svista: senza uno dei due non esisteva
 * nessuno scope di sede, quindi la lista sarebbe uscita su TUTTE le sedi. La
 * modalità nuova toglie quel muro **dichiarando la sede** invece di indovinarla,
 * ed è per questo che il rilievo più grave possibile su questa rotta — «una
 * segreteria vede le foto di un altro plesso» — qui si PROVA, non si argomenta.
 *
 * ⚠️ IL FINTO DATABASE APPLICA I FILTRI DAVVERO. Un mock piatto — che risponde
 * le stesse righe a ogni query — sarebbe verde con la correzione e senza: è già
 * successo in questo repo (13.254 test verdi e il difetto vivo in produzione).
 * Qui `.in('scuola_id', …)`, `.contains('tag_students', …)`, `.or(…)`, le
 * finestre di data, l'ordinamento e `.range()` sono eseguiti sulle righe, così
 * togliere il filtro di sede dalla route fa diventare rosso il test (A).
 *
 * ⚠️ NIENTE DATI VERI. Gli uuid e i nomi qui dentro sono inventati: in
 * produzione ci sono anagrafiche di minori e questo repository è pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

// uuid validi (z.guid: 8-4-4-4-12), tutti inventati.
const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SEDE_C = 'cccccccc-0000-4000-8000-00000000000c'
const SEZ_A = '5ec71011-0000-4000-8000-00000000000a'
const SEZ_B = '5ec71011-0000-4000-8000-00000000000b'
const ALU_A1 = 'a1a1a1a1-1111-4111-8111-111111111111'
const ALU_A2 = 'a2a2a2a2-2222-4222-8222-222222222222'
const ALU_B1 = 'b1b1b1b1-3333-4333-8333-333333333333'
const CLASSE_OMONIMA = 'GIRASOLI'

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
    /** Codice PostgREST da restituire alla SELECT dei media che filtra per sede. */
    erroreSedeMedia: null as string | null,
    /** Codice PostgREST da restituire alla lettura dei nomi degli alunni. */
    erroreAlunni: null as string | null,
    /** Le chiamate di firma dei link: `[percorsi, ttl]`. */
    firme: [] as Array<{ percorsi: string[]; ttl: number }>,
}))

// I gate: le identità si iniettano, il resto della route è reale.
vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: h.requireStaff,
    requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))

// ⚠️ `@/lib/auth/scope` NON è mockato: `scuoleDiUtente` e `restringiSedi` sono
// quelli veri, quindi «quali plessi può vedere chi chiede» lo decide il codice di
// produzione e non questo file. È la metà del test che conta di più.
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: h.logEvento,
}))

// ─────────────────────────────────────────────────────────────────────────────
// Il finto PostgREST — piccolo, ma esegue davvero i filtri.
// ─────────────────────────────────────────────────────────────────────────────
type Riga = Record<string, unknown>
type Stato = {
    tabella: string
    eq: Array<[string, unknown]>
    dentro: Array<[string, unknown[]]>
    contiene: Array<[string, unknown[]]>
    gte: Array<[string, string]>
    lte: Array<[string, string]>
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
    return []
}

function applica(s: Stato): Riga[] {
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

const adminClient = {
    from(tabella: string) {
        const s: Stato = { tabella, eq: [], dentro: [], contiene: [], gte: [], lte: [], or: [], ordine: [] }
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = (col: string, val: unknown) => {
            s.eq.push([col, val])
            return b
        }
        b.in = (col: string, vals: unknown[]) => {
            s.dentro.push([col, vals])
            return b
        }
        b.contains = (col: string, vals: unknown[]) => {
            s.contiene.push([col, vals])
            return b
        }
        b.gte = (col: string, val: string) => {
            s.gte.push([col, val])
            return b
        }
        b.lte = (col: string, val: string) => {
            s.lte.push([col, val])
            return b
        }
        b.or = (espressione: string) => {
            s.or.push(espressione)
            return b
        }
        b.not = () => b
        b.order = (col: string, opt?: { ascending?: boolean }) => {
            s.ordine.push({ col, asc: opt?.ascending !== false })
            return b
        }
        b.range = async (da: number, a: number) => {
            // Il degrado del DB E2E non migrato: la SELECT che filtra per sede fallisce.
            if (s.dentro.some(([c]) => c === 'scuola_id') && h.erroreSedeMedia) {
                return { data: null, count: null, error: { code: h.erroreSedeMedia } }
            }
            const righe = applica(s)
            return { data: righe.slice(da, a + 1), count: righe.length, error: null }
        }
        b.maybeSingle = async () => ({ data: applica(s)[0] ?? null, error: null })
        b.single = async () => ({ data: applica(s)[0] ?? null, error: null })
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
            if (s.tabella === 'alunni' && h.erroreAlunni) {
                return Promise.resolve({ data: null, error: { code: h.erroreAlunni } }).then(res, rej)
            }
            return Promise.resolve({ data: applica(s), error: null }).then(res, rej)
        }
        return b
    },
    storage: {
        from: () => ({
            createSignedUrls: async (percorsi: string[], ttl: number) => {
                h.firme.push({ percorsi, ttl })
                return {
                    data: percorsi.map((p) => ({ path: p, signedUrl: `https://firmato.test/${p}`, error: null })),
                    error: null,
                }
            },
        }),
    },
}

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
    createAdminClient: async () => adminClient,
}))

import { GET } from '@/app/api/gallery/route'
// La primitiva si prova ANCHE da sola: la garanzia che qui interessa (sede non
// dichiarata ⇒ si nega) deve reggere senza la validazione della rotta, che è la
// riga che un giorno potrebbe non esserci più. Vedi il gruppo (H).
import { risolviSedeDellaVista } from '@/lib/gallery/vista-sede'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import type { SupabaseClient } from '@supabase/supabase-js'

const req = (qs: string) => new Request(`http://localhost/api/gallery${qs ? `?${qs}` : ''}`)
const SEGRETERIA_A = { id: '5e9e0000-0000-4000-8000-00000000000a', role: 'segreteria', scuola_id: SEDE_A }
const eventi = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')
const esiti = () => eventi().map((c) => (c[2] as { esito?: string } | undefined)?.esito)

beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { ...SEGRETERIA_A } })
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-a', role: 'educator', scuola_id: SEDE_A } })
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
    h.erroreSedeMedia = null
    h.erroreAlunni = null
    h.firme = []
    h.schools = [{ id: SEDE_A }, { id: SEDE_B }, { id: SEDE_C }]
    h.utentiScuole = []
    h.utenti = [
        { id: 'ed-a', nome: 'Maestra', cognome: 'Della A', first_name: null, last_name: null },
        { id: 'ed-b', nome: 'Maestra', cognome: 'Della B', first_name: null, last_name: null },
    ]
    h.sections = [
        { id: SEZ_A, name: CLASSE_OMONIMA, scuola_id: SEDE_A },
        { id: SEZ_B, name: CLASSE_OMONIMA, scuola_id: SEDE_B },
    ]
    h.alunni = [
        { id: ALU_A1, nome: 'Primo', cognome: 'Della A', classe_sezione: CLASSE_OMONIMA, section_id: SEZ_A, scuola_id: SEDE_A },
        { id: ALU_A2, nome: 'Secondo', cognome: 'Della A', classe_sezione: 'TULIPANI', section_id: null, scuola_id: SEDE_A },
        { id: ALU_B1, nome: 'Unico', cognome: 'Della B', classe_sezione: CLASSE_OMONIMA, section_id: SEZ_B, scuola_id: SEDE_B },
    ]
    h.media = [
        {
            id: 'foto-A-vecchia', scuola_id: SEDE_A, uploaded_by: 'ed-a', file_url: 'uploads/a/1.jpg',
            file_type: 'foto', caption: null, tag_students: [ALU_A1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-01T08:00:00.000Z',
        },
        {
            id: 'foto-A-recente', scuola_id: SEDE_A, uploaded_by: 'ed-a', file_url: 'uploads/a/2.jpg',
            file_type: 'foto', caption: 'gita', tag_students: [ALU_A2], is_broadcast: false,
            target_classes: null, created_at: '2026-09-04T08:00:00.000Z',
        },
        {
            id: 'foto-B', scuola_id: SEDE_B, uploaded_by: 'ed-b', file_url: 'uploads/b/1.jpg',
            file_type: 'foto', caption: null, tag_students: [ALU_B1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-05T08:00:00.000Z',
        },
    ]
})

/* ────────────────────────────────────────────────────────────────────────────
 * (A) IL RILIEVO PIÙ GRAVE POSSIBILE SU QUESTA ROTTA.
 * Non «la route ha un filtro»: «la segreteria di A, chiedendo la sua sede, non
 * riceve la foto di B». Le due sedi hanno per giunta una classe OMONIMA, che è
 * il modo in cui l'isolamento è già saltato una volta in questo repo.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(A) isolamento fra sedi — la prova, non il ragionamento', () => {
    it('la segreteria di A vede TUTTE le foto di A e NESSUNA di B', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
        expect(ids.sort()).toEqual(['foto-A-recente', 'foto-A-vecchia'])
        expect(ids, 'una foto di un altro plesso nella galleria della segreteria').not.toContain('foto-B')
        expect(j.total).toBe(2)
    })

    it('anche col filtro di classe OMONIMA fra le due sedi, la sede B resta fuori', async () => {
        // Stessa classe «GIRASOLI» in A e in B: se il filtro di sede cadesse, il
        // nome basterebbe a far entrare il bambino dell'altro plesso.
        h.media.push({
            id: 'foto-B-girasoli', scuola_id: SEDE_B, uploaded_by: 'ed-b', file_url: 'uploads/b/2.jpg',
            file_type: 'foto', caption: null, tag_students: [ALU_B1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-05T09:00:00.000Z',
        })
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&classe=${CLASSE_OMONIMA}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
        expect(ids).toEqual(['foto-A-vecchia'])
        // …ed è passata dal gate della SEGRETERIA, non dal ramo storico del docente.
        expect(h.requireDocente).not.toHaveBeenCalled()
    })

    it('la sede si DICHIARA: una segreteria non può chiedere il plesso di un\'altra', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_B}`))
        expect(res.status).toBe(403)
        const j = await res.json()
        expect(j.codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(esiti()).toContain('vista-sede-non-accessibile')
    })

    it('l\'admin di DUE plessi vede solo quello che ha dichiarato', async () => {
        // `scuoleDiUtente` è quello VERO: per un admin legge `utenti_scuole`.
        const admin = { id: 'ad100000-0000-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
        h.requireStaff.mockResolvedValue({ user: admin })
        h.utentiScuole = [
            { utente_id: admin.id, scuola_id: SEDE_A },
            { utente_id: admin.id, scuola_id: SEDE_B },
        ]
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_B}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-B'])

        // …e la terza sede, che non ha, resta negata.
        const negato = await GET(req(`scope=sede&scuolaId=${SEDE_C}`))
        expect(negato.status).toBe(403)
    })

    it('la sede scritta in MAIUSCOLO è la propria e non va negata (uuid è un tipo, non una stringa)', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A.toUpperCase()}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect(j.total).toBe(2)
        // Ciò che finisce nel filtro è la forma CANONICA del database.
        expect((j.media as Array<{ scuola_id: string }>).every((m) => m.scuola_id === SEDE_A)).toBe(true)
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (B) IL MURO STORICO RESTA IN PIEDI PER CHI NON DICHIARA LA SEDE.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(B) i chiamanti vecchi non cambiano di una riga', () => {
    it('senza `classe`, senza `studentId` e senza `scope`: 400, come prima', async () => {
        const res = await GET(req(''))
        expect(res.status).toBe(400)
        const j = await res.json()
        expect(j.error).toMatch(/Specificare la classe/)
    })

    it('`scope=sede` senza `scuolaId` è un 400 di validazione, non una lista di tutte le sedi', async () => {
        const res = await GET(req('scope=sede'))
        expect(res.status).toBe(400)
        const j = await res.json()
        expect(j.error).toBe('Dati non validi')
        expect(JSON.stringify(j.details)).toMatch(/scuolaId/)
    })

    it('`scuolaId` senza `scope=sede` non viene scartato in silenzio: 400', async () => {
        // `z.object` non-strict butta via i campi fuori schema SENZA dirlo, ed è
        // già costato tre incidenti qui dentro. Una sede dichiarata e ignorata
        // sarebbe il quarto.
        const res = await GET(req(`scuolaId=${SEDE_A}&classe=${CLASSE_OMONIMA}`))
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('Dati non validi')
    })

    it('`scope` con un valore che non conosciamo è un 400 di VALIDAZIONE, non un ripiego sul comportamento storico', async () => {
        const res = await GET(req(`scope=tutto&classe=${CLASSE_OMONIMA}`))
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('Dati non validi')
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (C) IL GATE: la vista di sede è della SEGRETERIA, non di chi insegna.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(C) gate di ruolo', () => {
    it('l\'educator non entra nella vista di sede (requireStaff, non requireDocente)', async () => {
        h.requireStaff.mockResolvedValue({
            response: new Response(JSON.stringify({ error: 'negato' }), { status: 403 }),
        })
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(403)
        // E il gate ha parlato PRIMA di qualunque lettura: nessuna firma emessa.
        expect(h.firme).toHaveLength(0)
    })

    it('è `requireStaff` a essere interrogato, non `requireDocente`', async () => {
        await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(h.requireStaff).toHaveBeenCalledTimes(1)
        expect(h.requireDocente).not.toHaveBeenCalled()
        expect(h.requireParentOfStudent).not.toHaveBeenCalled()
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (D) I FILTRI: classe, bambino, data. E l'ordine dal più recente.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(D) filtri e ordinamento', () => {
    it('per CLASSE: risale `tag_students` → `alunni.section_id`, non una colonna sulla foto', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&classe=${CLASSE_OMONIMA}`))
        const j = await res.json()
        // `foto-A-recente` tagga un bambino di TULIPANI: fuori dal filtro.
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-A-vecchia'])
        expect(j.total).toBe(1)
        expect(h.requireDocente).not.toHaveBeenCalled()
    })

    it('per CLASSE inesistente nella sede: elenco vuoto e un `warn`, mai la sede intera', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&classe=CLASSE-CHE-NON-ESISTE`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect(j.total).toBe(0)
        expect(esiti()).toContain('classe-non-risolta')
    })

    it('per BAMBINO: solo le foto in cui è taggato — E CON I NOMI, come senza filtro', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&studentId=${ALU_A2}`))
        const j = await res.json()
        const riga = (j.media as Array<Record<string, unknown>>)[0]
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-A-recente'])
        // Il gate è quello dello staff: la vista di sede non passa mai da `requireParentOfStudent`.
        expect(h.requireParentOfStudent).not.toHaveBeenCalled()

        // ⚠️ QUESTE DUE RIGHE ERANO ROSSE, e il filtro rispondeva lo stesso 200.
        // La proiezione del GENITORE era attivata da `Boolean(studentId)`, che è
        // vera anche qui: `tag_students` spariva PRIMA che i nomi si leggessero,
        // e ogni foto usciva con `alunni_taggati: []`. Un filtro che spegne
        // silenziosamente metà della risposta è peggio di un filtro che sbaglia:
        // la schermata mostra una foto senza etichette e sembra un dato mancante.
        expect(riga.alunni_taggati, 'la vista di sede filtrata per bambino ha perso i nomi').toEqual([
            { id: ALU_A2, nome: 'Secondo Della A', classe: 'TULIPANI' },
        ])
        // …e `tag_students` resta, perché è una schermata di personale: è lo
        // stesso campo su cui la segreteria ri-tagga dalla lightbox.
        expect(riga.tag_students).toEqual([ALU_A2])
    })

    it('per BAMBINO di un ALTRO plesso: 403, non un 200 vuoto che sembra «nessuna foto»', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&studentId=${ALU_B1}`))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(esiti()).toContain('vista-sede-alunno-fuori-sede')
    })

    it('per BAMBINO nella vista di sede i broadcast NON entrano: è un filtro, non la vista famiglia', async () => {
        h.media.push({
            id: 'broadcast-A', scuola_id: SEDE_A, uploaded_by: 'ed-a', file_url: 'uploads/a/3.jpg',
            file_type: 'foto', caption: null, tag_students: [], is_broadcast: true,
            target_classes: [CLASSE_OMONIMA], created_at: '2026-09-04T12:00:00.000Z',
        })
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&studentId=${ALU_A1}`))
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-A-vecchia'])
    })

    it('per DATA: un giorno solo', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}&date=2026-09-04`))
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-A-recente'])
    })

    it('l\'ordine è dal PIÙ RECENTE', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        const j = await res.json()
        expect((j.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['foto-A-recente', 'foto-A-vecchia'])
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (E) PAGINAZIONE — 301 foto oggi, e crescono ogni giorno.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(E) paginazione obbligatoria', () => {
    beforeEach(() => {
        h.media = Array.from({ length: 120 }, (_, i) => ({
            id: `foto-${String(i).padStart(3, '0')}`,
            scuola_id: SEDE_A,
            uploaded_by: 'ed-a',
            file_url: `uploads/a/${i}.jpg`,
            file_type: 'foto',
            caption: null,
            tag_students: [],
            is_broadcast: false,
            target_classes: null,
            // Il più recente è l'ultimo generato.
            created_at: `2026-09-05T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
        }))
    })

    it('la pagina predefinita è 30 righe, e `total` è il totale VERO', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        const j = await res.json()
        expect((j.media as unknown[]).length).toBe(30)
        expect(j.total).toBe(120)
        expect(j.limit).toBe(30)
        expect(j.offset).toBe(0)
    })

    it('`limit` e `offset` scorrono le pagine e non si sovrappongono', async () => {
        const p1 = await (await GET(req(`scope=sede&scuolaId=${SEDE_A}&limit=10&offset=0`))).json()
        const p2 = await (await GET(req(`scope=sede&scuolaId=${SEDE_A}&limit=10&offset=10`))).json()
        const id1 = (p1.media as Array<{ id: string }>).map((m) => m.id)
        const id2 = (p2.media as Array<{ id: string }>).map((m) => m.id)
        expect(id1).toHaveLength(10)
        expect(id2).toHaveLength(10)
        expect(id1.filter((x) => id2.includes(x))).toEqual([])
        expect(p1.limit).toBe(10)
        expect(p2.offset).toBe(10)
    })

    it('un `limit` sopra il tetto viene riportato a 100, e la risposta lo DICE', async () => {
        const j = await (await GET(req(`scope=sede&scuolaId=${SEDE_A}&limit=5000`))).json()
        expect((j.media as unknown[]).length).toBe(100)
        // Il clamp è silenzioso da sempre su questa rotta: che almeno si veda.
        expect(j.limit).toBe(100)
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (F) COSA ARRIVA ALLA PAGINA — il contratto su cui costruisce l'altro agente.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(F) forma della risposta', () => {
    it('ogni foto porta il link FIRMATO, l\'uploader e i bambini taggati della sede', async () => {
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        const j = await res.json()
        const recente = (j.media as Array<Record<string, unknown>>).find((m) => m.id === 'foto-A-recente')!
        expect(recente.file_url).toBe('https://firmato.test/uploads/a/2.jpg')
        expect(recente.uploader_name).toBe('Maestra Della A')
        expect(recente.created_at).toBe('2026-09-04T08:00:00.000Z')
        expect(recente.scuola_id).toBe(SEDE_A)
        expect(recente.alunni_taggati).toEqual([
            { id: ALU_A2, nome: 'Secondo Della A', classe: 'TULIPANI' },
        ])
    })

    it('la firma dura 600 s: la vista di sede non è un varco', async () => {
        await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(h.firme).toHaveLength(1)
        expect(h.firme[0].ttl).toBe(600)
    })

    it('un tag che punta FUORI dalla sede non porta con sé nessun nome, e lascia un `warn`', async () => {
        // Anomalia: una riga della sede A che tagga un bambino di B. Il nome del
        // minore altrui non esce, e il fatto non resta muto.
        h.media = [{
            id: 'foto-anomala', scuola_id: SEDE_A, uploaded_by: 'ed-a', file_url: 'uploads/a/9.jpg',
            file_type: 'foto', caption: null, tag_students: [ALU_A1, ALU_B1], is_broadcast: false,
            target_classes: null, created_at: '2026-09-05T10:00:00.000Z',
        }]
        const j = await (await GET(req(`scope=sede&scuolaId=${SEDE_A}`))).json()
        const riga = (j.media as Array<Record<string, unknown>>)[0]
        expect(riga.alunni_taggati).toEqual([{ id: ALU_A1, nome: 'Primo Della A', classe: CLASSE_OMONIMA }])
        expect(JSON.stringify(riga)).not.toContain('Della B')
        expect(esiti()).toContain('vista-sede-tag-fuori-sede')
    })

    it('se i nomi non si leggono, le foto si vedono lo stesso — e il guasto si logga', async () => {
        h.erroreAlunni = '42703'
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect((j.media as unknown[]).length).toBe(2)
        expect((j.media as Array<Record<string, unknown>>)[0].alunni_taggati).toEqual([])
        expect(esiti()).toContain('vista-sede-nomi-non-letti')
    })

    it('la lettura di sede lascia la sua riga di log, anche quando va bene', async () => {
        await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        const riga = eventi().find((c) => (c[2] as { esito?: string })?.esito === 'vista-sede')
        expect(riga, 'senza il log del successo, «nessun log» non distingue «tutto ok» da «non è mai partito niente»').toBeDefined()
        expect(riga![1]).toBe('info')
        expect(riga![2]).toMatchObject({ operazione: 'gallery:GET', sede_id: SEDE_A, n: 2, total: 2 })
        // Mai un id di minore nei log.
        expect(JSON.stringify(riga![2])).not.toContain(ALU_A1)
    })

    it('la vista di FAMIGLIA, invece, resta minimizzata: né `tag_students` né `alunni_taggati`', async () => {
        // La controprova dell'asserzione del gruppo (D). La proiezione GDPR non
        // si spegne «per la sede»: si spegne SOLO nella vista di sede, e questa
        // riga è l'unica cosa che impedisce di correggere quel difetto passando
        // da `Boolean(studentId)` a un `false` che accontenta il test di sopra.
        // Prima di oggi nessun test guardava questo campo sulla ROTTA: la
        // minimizzazione era provata sulla sola funzione pura
        // (`gallery-minimizzazione-genitore`), cioè su un pezzo che il difetto
        // non toccava.
        const res = await GET(req(`studentId=${ALU_A1}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        const riga = (j.media as Array<Record<string, unknown>>)[0]
        expect(riga.id).toBe('foto-A-vecchia')
        // Gli uuid degli ALTRI minori ritratti nella stessa foto: GDPR art. 5.1.c.
        expect(riga, 'al genitore sono tornati gli uuid dei bambini taggati').not.toHaveProperty('tag_students')
        // …e nemmeno i nomi: i taggati si attaccano solo nella vista di sede.
        expect(riga.alunni_taggati).toBeUndefined()
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (G) IL DEGRADO NON PUÒ ESSERE UN FAIL-OPEN.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(G) colonna di sede assente su impianto multi-sede', () => {
    it('con tre sedi reali e la colonna mancante si NEGA, non si legge senza filtro', async () => {
        h.erroreSedeMedia = '42703'
        const res = await GET(req(`scope=sede&scuolaId=${SEDE_A}`))
        expect(res.status).toBe(500)
        expect((await res.json()).error).toMatch(/Isolamento per sede/)
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * (H) LA SEDE NON DICHIARATA SI NEGA DENTRO LA PRIMITIVA, non «più su».
 *
 * Dalla rotta qui non ci si arriva: lo `superRefine` dello schema pretende
 * `scuolaId` insieme a `scope=sede`, e il gruppo (B) lo prova. Ma quella regola
 * vive in un ALTRO file, e fino al 2026-09-06 la chiamata le passava accanto un
 * `scuolaId as string` che toglieva al compilatore l'unica domanda che poteva
 * fare. Tolta la sola regola dello schema, `tsc` restava verde e
 * `restringiSedi(accessibili, undefined)` — che comincia con
 * `if (!scuolaId) return attive` — restituiva TUTTI i plessi accessibili: 200
 * con le foto di due sedi a chi ne aveva chiesta una.
 *
 * Perciò la garanzia si prova DOVE VIVE, sulla funzione, senza passare dalla
 * validazione che un giorno potrebbe non esserci più.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(H) sede mancante ⇒ si nega, mai l\'elenco dei plessi accessibili', () => {
    const finto = adminClient as unknown as SupabaseClient
    const ADMIN_AB: AppUser = { id: 'ad100000-0000-4000-8000-000000000002', role: 'admin', scuola_id: SEDE_A }

    beforeEach(() => {
        // Un admin con DUE plessi: è l'unico caso in cui il fail-open si vede.
        // Con una sede sola «tutti i plessi accessibili» e «il plesso chiesto»
        // coincidono, e un difetto che non cambia la risposta non si misura.
        h.utentiScuole = [
            { utente_id: ADMIN_AB.id, scuola_id: SEDE_A },
            { utente_id: ADMIN_AB.id, scuola_id: SEDE_B },
        ]
    })

    it('`undefined`: 400 `SEDE_DA_SPECIFICARE`, e di `plessi` non esce nemmeno il campo', async () => {
        const esito = await risolviSedeDellaVista(finto, ADMIN_AB, undefined)
        expect(esito.plessi, 'la sede non dichiarata è diventata «tutti i plessi accessibili»').toBeUndefined()
        expect(esito.response).toBeDefined()
        expect(esito.response!.status).toBe(400)
        expect((await esito.response!.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        // Se questa riga compare, la validazione a monte è saltata: `warn`, e
        // solo uuid e conteggi — da questa funzione passano anagrafiche di minori.
        const riga = eventi().find((c) => (c[2] as { esito?: string })?.esito === 'vista-sede-senza-sede')
        expect(riga, 'un diniego muto non si distingue da una chiamata mai avvenuta').toBeDefined()
        expect(riga![1]).toBe('warn')
        expect(JSON.stringify(riga![2])).not.toContain(ALU_A1)
    })

    it('stringa vuota: stesso diniego (`?scuolaId=` senza valore arriva così)', async () => {
        const esito = await risolviSedeDellaVista(finto, ADMIN_AB, '')
        expect(esito.plessi).toBeUndefined()
        expect(esito.response!.status).toBe(400)
    })

    it('controprova: con la sede DICHIARATA passa, e restringe a quella sola', async () => {
        // Senza questa riga i due test qui sopra resterebbero verdi anche davanti
        // a una funzione che nega sempre — cioè davanti a una galleria di sede
        // che non si apre più.
        const esito = await risolviSedeDellaVista(finto, ADMIN_AB, SEDE_B)
        expect(esito.response).toBeUndefined()
        expect(esito.plessi).toEqual([SEDE_B])
    })
})
