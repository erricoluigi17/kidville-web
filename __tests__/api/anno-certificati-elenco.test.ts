// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 3.5-1 · il certificato delle competenze e l'elenco di classe dichiarano l'anno.
 *
 *  · `POST /api/admin/competenze` → `seedCertificato` (il primo `upsert`, su `certificati_competenze`,
 *    in modo `dichiarato`); il secondo (`certificato_competenza_livelli`) non scrive l'anno.
 *  · `POST /api/admin/iscrizioni/elenco` → la riga di `iscrizioni_elenco_caricamenti` (`dichiarato`);
 *    le righe `iscrizioni_elenco_righe` sono in modo `madre` e non lo scrivono.
 *
 * Database finto che applica i filtri ed esegue le scritture; finti solo il gate di ruolo, il client admin
 * (con uno Storage finto per l'elenco), la lettura del foglio Excel e l'audit. `resolveAnnoScrittura` è quello
 * vero. L'orologio non si congela. `anno_id` è `anni_scolastici.id` (`a2…` = `corrente`).
 * La rete di `withRoute` (3.4) qui non scatta: il 409 di `ANNO_CHIUSO` è la traduzione ESPLICITA della route.
 */

const h = vi.hoisted(() => ({
    ruolo: 'admin' as string,
    utente: '' as string,
    attive: [] as string[],
    saltaScopeSezione: false,
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    usiChiesti: [] as number[],
    nRighe: 1,
    logEvento: vi.fn(),
    logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: h.utente, role: h.ruolo, scuola_id: h.attive[0] ?? null } })
    },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return {
        ...vero,
        resolveScuoleAttive: async () => [...h.attive],
        // solo per il test del guasto di `sedeDellaSezione`: il gate di scope legge la stessa tabella e cadrebbe prima
        assertSezioneInScope: async (...a: Parameters<typeof vero.assertSezioneInScope>) =>
            h.saltaScopeSezione ? null : vero.assertSezioneInScope(...a),
    }
})
// Ogni client scrive nell'accumulatore comune MARCANDO la scrittura con l'header del gettone che porta
// (`null` per il client senza): così un test sa da quale client è passata ogni scrittura.
vi.mock('@/lib/supabase/server-client', () => {
    const nuovo = (header: string | null) => {
        const mio = [] as Scrittura[]
        mio.push = (...s: Scrittura[]) => {
            for (const x of s) (h.scritture as unknown[]).push({ ...x, header })
            return mio.length
        }
        const finto = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: mio })
        const storage = {
            from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }),
        }
        return Object.assign(finto, { storage })
    }
    return {
        createAdminClient: async () => nuovo(null),
        createAdminClientConHeader: async (hd: Record<string, string>) => nuovo(hd['x-kidville-correzione'] ?? null),
    }
})
// Il finto genera id che non sono uuid: i gettoni (veri: `conGettone` li valida) si creano qui, e si
// registra quanti ne chiede la route (`usi`).
const GETTONI = ['f1111111-1111-4111-8111-111111111111', 'f2222222-2222-4222-8222-222222222222', 'f3333333-3333-4333-8333-333333333333']
vi.mock('@/lib/anno/gettone', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/anno/gettone')>()
    return {
        ...vero,
        creaGettoni: async (_s: unknown, r: { usi?: number }) => {
            h.usiChiesti.push(r.usi ?? 1)
            return Array.from({ length: r.usi ?? 1 }, (_, i) => GETTONI[i % GETTONI.length])
        },
    }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/iscrizioni/import/elenco', () => ({
    leggiElenco: () => ({
        righe: Array.from({ length: h.nRighe }, (_, i) => ({
            classe: '2 ANNI', nome: `Nome Finto ${i}`, nomeNorm: `nome finto ${i}`, rigaExcel: i + 2, retta: 100, rettaTesto: null,
        })),
        anomalie: [],
        perClasse: [{ classe: '2 ANNI', alunni: h.nRighe }],
    }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST as POST_COMPETENZE } from '@/app/api/admin/competenze/route'
import { POST as POST_ELENCO } from '@/app/api/admin/iscrizioni/elenco/route'

const ADM = '20000000-0000-4000-8000-000000000001'
const SEZ_A = 'c1000000-0000-4000-8000-00000000000a'
const SEZ_B = 'c1000000-0000-4000-8000-00000000000b'
const AL_1 = 'b0000000-0000-4000-8000-000000000001'
const AL_2 = 'b0000000-0000-4000-8000-000000000002'
const SCRUT = 'd0000000-0000-4000-8000-000000000001'
const PER = 'e0000000-0000-4000-8000-000000000001'
// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione
// `anni_sede.id`
const S2A = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3A = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const S2B = 'b2222222-2222-4222-8222-bbbbbbbbbbbb'

const scritte = (tabella: string, op = 'insert') =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && (s.operazione === op || (op === 'insert' && s.operazione === 'upsert')))

beforeEach(() => {
    h.ruolo = 'admin'
    h.utente = ADM
    h.attive = [SEDE_A]
    h.errori = {}
    h.saltaScopeSezione = false
    h.scritture = []
    h.usiChiesti = []
    h.nRighe = 1
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        anni_sede: [
            { id: S2A, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
            { id: S3A, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
            { id: S2B, scuola_id: SEDE_B, anno_id: A2, stato: 'corrente', domande_aperte: false },
        ],
        utenti_scuole: [],
        sections: [
            { id: SEZ_A, scuola_id: SEDE_A, name: '5 A', school_type: 'primaria' },
            { id: SEZ_B, scuola_id: SEDE_B, name: '5 B', school_type: 'primaria' },
            { id: 'c1000000-0000-4000-8000-0000000000a2', scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
        ],
        alunni: [
            { id: AL_1, section_id: SEZ_A },
            { id: AL_2, section_id: SEZ_A },
        ],
        scrutini: [{ id: SCRUT, section_id: SEZ_A, stato: 'chiuso', periodo_id: PER, creato_il: '2026-06-10T10:00:00Z' }],
        scrutinio_periodi: [{ id: PER, anno_scolastico: '2026/2027' }],
        scrutinio_giudizi: [],
        materie: [],
        certificati_competenze: [],
        certificato_competenza_livelli: [],
        iscrizioni_elenco_caricamenti: [],
        iscrizioni_elenco_righe: [],
    }
})

// ── il certificato delle competenze ─────────────────────────────────────────
const postCompetenze = (b: unknown) =>
    POST_COMPETENZE(
        new NextRequest('http://localhost/api/admin/competenze', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )

describe('POST /api/admin/competenze · l\'anno del certificato', () => {
    it('il certificato nasce con l\'anno del `corrente` (a)', async () => {
        const res = await postCompetenze({ sectionId: SEZ_A, alunnoId: AL_1 })
        expect(res.status).toBe(200)
        expect(scritte('certificati_competenze')).toHaveLength(1)
        expect(scritte('certificati_competenze')[0].valori[0]).toMatchObject({ alunno_id: AL_1, anno_id: A2, scuola_id: SEDE_A })
    })

    it('il secondo upsert (le righe di competenza) non scrive anno_id', async () => {
        await postCompetenze({ sectionId: SEZ_A, alunnoId: AL_1 })
        const livelli = scritte('certificato_competenza_livelli')
        expect(livelli.length).toBeGreaterThan(0)
        for (const r of livelli.flatMap((s) => s.valori)) expect(r).not.toHaveProperty('anno_id')
    })

    it('un certificato già presente (l\'upsert aggiorna) porta comunque anno_id, anche nella riga finale', async () => {
        h.db.certificati_competenze = [
            { id: 'f0000000-0000-4000-8000-000000000001', alunno_id: AL_1, anno_scolastico: '2026/2027', stato: 'bozza', scuola_id: SEDE_A },
        ]
        const res = await postCompetenze({ sectionId: SEZ_A, alunnoId: AL_1 })
        expect(res.status).toBe(200)
        expect(scritte('certificati_competenze')[0].valori[0]).toMatchObject({ anno_id: A2 })
        expect(h.db.certificati_competenze).toHaveLength(1)
        expect(h.db.certificati_competenze[0]).toMatchObject({ anno_id: A2 })
    })

    it('una classe intera: ogni certificato porta l\'anno', async () => {
        const res = await postCompetenze({ sectionId: SEZ_A })
        expect(res.status).toBe(200)
        expect(scritte('certificati_competenze')).toHaveLength(2)
        for (const s of scritte('certificati_competenze')) expect(s.valori[0]).toMatchObject({ anno_id: A2 })
    })

    it('la sede della sezione non si legge (guasto su `sections`): 500 e NESSUNA scrittura su certificati_competenze', async () => {
        h.saltaScopeSezione = true
        h.errori = { 'sections:select': { code: '57014', message: 'canceling statement' } }
        const res = await postCompetenze({ sectionId: SEZ_A })
        expect(res.status).toBe(500)
        expect(scritte('certificati_competenze')).toHaveLength(0)
        expect(h.db.certificati_competenze).toHaveLength(0)
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 2xx (b)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await postCompetenze({ sectionId: SEZ_A, alunnoId: AL_1 })
        expect(res.status).toBe(200)
        expect(scritte('certificati_competenze')).toHaveLength(1)
        expect(scritte('certificati_competenze')[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('se l\'upsert risponde ANNO_CHIUSO la risposta è 409 con il codice, senza la rete di withRoute (c)', async () => {
        h.errori = { 'certificati_competenze:upsert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await postCompetenze({ sectionId: SEZ_A, alunnoId: AL_1 })
        expect(res.status).toBe(409)
        const corpo = await res.json()
        expect(corpo.errori[0].codice).toBe('ANNO_CHIUSO')
        expect(scritte('certificato_competenza_livelli')).toHaveLength(0)
    })

    it('la sede è quella della SEZIONE, mai indovinata: un admin con due sedi scrive nell\'anno della sede della classe (d)', async () => {
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [
            { utente_id: ADM, scuola_id: SEDE_A },
            { utente_id: ADM, scuola_id: SEDE_B },
        ]
        // La classe quinta di B non ha uno scrutinio chiuso: il rifiuto è del dominio, ma prima dell'upsert
        // l'anno si è risolto sulla sede B e non sulla A. Si prova col `corrente` di B scritto a mano.
        h.db.anni_sede = h.db.anni_sede.map((r) => (r.id === S2B ? { ...r, anno_id: A3 } : r))
        h.db.scrutini.push({ id: 'd0000000-0000-4000-8000-000000000002', section_id: SEZ_B, stato: 'chiuso', periodo_id: PER, creato_il: '2026-06-11T10:00:00Z' })
        h.db.alunni.push({ id: 'b0000000-0000-4000-8000-000000000009', section_id: SEZ_B })
        const res = await postCompetenze({ sectionId: SEZ_B, alunnoId: 'b0000000-0000-4000-8000-000000000009' })
        expect(res.status).toBe(200)
        expect(scritte('certificati_competenze')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B, anno_id: A3 })
    })

    it('una sezione di una sede che non è dell\'utente → 403 e 0 scritture (d)', async () => {
        const res = await postCompetenze({ sectionId: SEZ_B, alunnoId: AL_1 })
        expect(res.status).toBe(403)
        expect(h.scritture).toEqual([])
    })
})

// ── l'elenco di classe ───────────────────────────────────────────────────────
const postElenco = (query = '', headers: Record<string, string> = {}) => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'elenco.xlsx'))
    return POST_ELENCO(new NextRequest(`http://localhost/api/admin/iscrizioni/elenco${query}`, { method: 'POST', body: form, headers }))
}

describe('POST /api/admin/iscrizioni/elenco · l\'anno del caricamento', () => {
    it('il caricamento nasce con l\'anno del `corrente` (a); le righe, in modo `madre`, non lo scrivono', async () => {
        h.ruolo = 'segreteria'
        const res = await postElenco()
        expect(res.status).toBe(200)
        expect(scritte('iscrizioni_elenco_caricamenti')).toHaveLength(1)
        expect(scritte('iscrizioni_elenco_caricamenti')[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, anno_id: A2 })
        expect(scritte('iscrizioni_elenco_righe')).toHaveLength(1)
        expect(scritte('iscrizioni_elenco_righe')[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 2xx (b)', async () => {
        h.ruolo = 'segreteria'
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await postElenco()
        expect(res.status).toBe(200)
        expect(scritte('iscrizioni_elenco_caricamenti')[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO, senza la rete di withRoute (c)', async () => {
        h.ruolo = 'segreteria'
        h.errori = { 'iscrizioni_elenco_caricamenti:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await postElenco()
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect(scritte('iscrizioni_elenco_righe')).toHaveLength(0)
    })

    it('due sedi nel cookie e nessuna indicata → 400 e 0 scritture (d)', async () => {
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [
            { utente_id: ADM, scuola_id: SEDE_A },
            { utente_id: ADM, scuola_id: SEDE_B },
        ]
        const res = await postElenco()
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })

    it('in agosto (il vecchio `in_chiusura`, nessun `corrente`) → 400 ANNO_DA_SPECIFICARE e 0 scritture', async () => {
        h.ruolo = 'segreteria'
        h.db.anni_sede = h.db.anni_sede.map((r) => (r.id === S2A ? { ...r, stato: 'in_chiusura' } : r))
        const res = await postElenco()
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })
})

describe('POST /api/admin/iscrizioni/elenco · il gettone vale una richiesta', () => {
    const registro = ['iscrizioni_elenco_caricamenti', 'iscrizioni_elenco_righe']
    const scrittureRegistro = () => (h.scritture as Array<Scrittura & { header: string | null }>).filter((s) => registro.includes(s.tabella))
    // Agosto: l'anno `in_chiusura` si sceglie col cookie `anno_attivo` (`anni_scolastici.id`).
    const inChiusura = () => {
        h.ruolo = 'segreteria'
        h.db.anni_sede = h.db.anni_sede.map((r) => (r.id === S2A ? { ...r, stato: 'in_chiusura' } : r))
        h.db.iscrizioni_elenco_caricamenti = [{ id: 'f9999999-9999-4999-8999-999999999999', scuola_id: SEDE_A, attivo: true }]
    }

    it('lo spegnimento del precedente, il caricamento e OGNI blocco di righe passano dal client col gettone; `usi` = richieste', async () => {
        inChiusura()
        h.nRighe = 450 // 3 blocchi da 200
        const res = await postElenco('', { cookie: `anno_attivo=${A2}` })
        expect(res.status).toBe(200)
        const sc = scrittureRegistro()
        expect(sc.map((s) => `${s.tabella}:${s.operazione}`)).toEqual([
            'iscrizioni_elenco_caricamenti:update',
            'iscrizioni_elenco_caricamenti:insert',
            'iscrizioni_elenco_righe:insert',
            'iscrizioni_elenco_righe:insert',
            'iscrizioni_elenco_righe:insert',
        ])
        for (const s of sc) expect(s.header, `${s.tabella}:${s.operazione}`).toMatch(/^f\d{7}-/)
        // spegni (1) + caricamento (1) + 3 blocchi + disfacimento (1)
        expect(h.usiChiesti).toEqual([6])
    })

    it('anno `corrente`: nessun gettone, tutto sul client semplice', async () => {
        h.ruolo = 'segreteria'
        const res = await postElenco()
        expect(res.status).toBe(200)
        for (const s of scrittureRegistro()) expect(s.header).toBeNull()
        expect(h.usiChiesti).toEqual([])
    })
})

export type { Riga }
