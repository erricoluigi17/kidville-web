// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

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
    letture: [] as string[],
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
        const finto = creaFintoSupabase(h.db as DBFinto, h.letture, { errori: h.errori, scritture: mio, rpc: { anno_attivo: () => ({ data: 'b2222222-2222-4222-8222-aaaaaaaaaaaa', error: null }) } })
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

import { POST as POST_ELENCO } from '@/app/api/admin/iscrizioni/elenco/route'

const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const S2A = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3A = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const ADM = '20000000-0000-4000-8000-000000000001'

// Compito 4.3.7 · la guardia «classe-senza-sezione» dell'elenco guarda le sezioni dell'anno ATTIVO.
// Il foglio dice «2 ANNI». Una sezione «2 ANNI» esiste solo nel 2027/28 (in preparazione): per l'anno in corso la
// classe NON esiste, e la guardia deve dirlo. Con lo schema indietro nessun filtro e nessun errore.
beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = ADM
    h.attive = [SEDE_A]
    h.errori = {}
    h.saltaScopeSezione = false
    h.scritture = []
    h.letture.length = 0
    h.usiChiesti = []
    h.nRighe = 1
    h.db = {
        anni_scolastici: [
            { id: A2, etichetta: '2026/2027', etichetta_breve: '2026/27' },
            { id: A3, etichetta: '2027/2028', etichetta_breve: '2027/28' },
        ],
        anno_regole: [{ guardia_attiva: false }],
        anni_sede: [
            { id: S2A, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
            { id: S3A, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
        ],
        utenti_scuole: [],
        sections: [
            { id: 'c1000000-0000-4000-8000-0000000000a1', scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia', anno_id: A2 },
            { id: 'c1000000-0000-4000-8000-0000000000a2', scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia', anno_id: A3 },
        ],
        alunni: [],
        iscrizioni_elenco_caricamenti: [],
        iscrizioni_elenco_righe: [],
    }
})

const postElenco = async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'elenco.xlsx'))
    return POST_ELENCO(new NextRequest('http://localhost/api/admin/iscrizioni/elenco', { method: 'POST', body: form }))
}
const generi = (corpo: { anomalie?: { genere: string }[] }) => (corpo.anomalie ?? []).map((a) => a.genere)

describe('POST /api/admin/iscrizioni/elenco · le sezioni del confronto sono quelle dell\'anno attivo', () => {
    it('la classe che esiste solo nel 2027/28 risulta «senza sezione» per l\'anno in corso', async () => {
        const res = await postElenco()
        expect(res.status).toBe(200)
        expect(generi(await res.json())).toContain('classe-senza-sezione')
    })

    it('con lo schema dell\'anno indietro: nessun filtro, la classe combacia, nessun errore', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        h.db.sections = h.db.sections.map((s) => {
            const c = { ...s }
            delete c.anno_id
            return c
        })
        const res = await postElenco()
        expect(res.status).toBe(200)
        expect(generi(await res.json())).not.toContain('classe-senza-sezione')
    })
})
