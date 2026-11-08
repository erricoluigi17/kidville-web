import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 4.3.7 · le liste di sezioni e le ricerche per NOME guardano l'anno.
 *
 * Il database è il finto che applica i filtri. `resolveAnnoLettura`, `resolveAnnoLetturaElenco` e
 * `anniAttiviDeiPlessi` sono i VERI; sono finti solo i gate di ruolo, il perimetro delle sedi e `sezioniDiUtente`.
 * L'anno attivo lo dice la RPC `anno_attivo` (finta, ma legge le righe di `anni_sede`). Il caso «DB non migrato»
 * (la CI) è `anni_sede` che risponde PGRST205: lì NIENTE filtro d'anno, come prima della PR 4.3.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    mie: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    attivoPerSede: {} as Record<string, string>,
}))

vi.mock('@/lib/auth/require-staff', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/require-staff')>()
    const utente = () => ({ id: h.utente, role: h.ruolo, ruolo: h.ruolo, scuola_id: h.attive[0] ?? null })
    return {
        ...vero,
        requireStaff: async () => ({ user: utente() }),
        requireDocente: async () => ({ user: utente() }),
    }
})
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return {
        ...vero,
        resolveScuoleAttive: async () => [...h.attive],
        scuoleDiUtente: async () => [...h.attive],
    }
})
vi.mock('@/lib/sezioni/docenti', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/sezioni/docenti')>()
    return { ...vero, sezioniDiUtente: async () => [...h.mie] }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => nuovoFinto(),
}))

function nuovoFinto() {
    return creaFintoSupabase(h.db as DBFinto, [], {
        errori: h.errori,
        rpc: {
            anno_attivo: (args: Riga) => ({ data: h.attivoPerSede[String(args.p_scuola)] ?? null, error: null }),
        },
    })
}

import { GET as SEZIONI_GET } from '@/app/api/admin/sections/route'
import { GET as SCOPED_GET } from '@/app/api/admin/sections/scoped/route'
import { GET as SEARCH_GET } from '@/app/api/admin/search/route'
import { GET as EDUCATOR_GET } from '@/app/api/educator-sections/route'
import { GET as PRIMARIA_SEZIONI_GET } from '@/app/api/primaria/sezioni/route'
import { GET as PRIMARIA_CLASSI_GET } from '@/app/api/primaria/classi/route'
import { GET as TASKS_META_GET } from '@/app/api/tasks/meta/route'
import { sezioniDiNome } from '@/lib/sezioni/risoluzione'
import { classiMancantiNellaSede } from '@/lib/avvisi/classi-sede'
import { assertClasseNomeInScope } from '@/lib/auth/scope'
import { classeEsisteInOgniSede } from '@/app/api/admin/students/route'

// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente (2026/27)
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione (2027/28)
// `anni_sede.id`
const S2A = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3A = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const S2B = 'b2222222-2222-4222-8222-bbbbbbbbbbbb'
const S3B = 'b3333333-3333-4333-8333-bbbbbbbbbbbb'
// sezioni (uuid finti)
const SEZ_1A_2627 = 'c1000000-0000-4000-8000-000000000001'
const SEZ_1A_2728 = 'c1000000-0000-4000-8000-000000000002'
const SEZ_2B_2728 = 'c1000000-0000-4000-8000-000000000003'
const SEZ_1A_B_2627 = 'c1000000-0000-4000-8000-000000000004'
const SEZ_1A_B_2728 = 'c1000000-0000-4000-8000-000000000005'
const SEG = '20000000-0000-4000-8000-000000000001'

const anniSede = (): Riga[] => [
    { id: S2A, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3A, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
    { id: S2B, scuola_id: SEDE_B, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3B, scuola_id: SEDE_B, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
]
const sezioni = (): Riga[] => [
    { id: SEZ_1A_2627, name: '1A', scuola_id: SEDE_A, anno_id: A2, school_type: 'primaria' },
    { id: SEZ_1A_2728, name: '1A', scuola_id: SEDE_A, anno_id: A3, school_type: 'primaria' },
    { id: SEZ_2B_2728, name: '2B', scuola_id: SEDE_A, anno_id: A3, school_type: 'primaria' },
    { id: SEZ_1A_B_2627, name: '1A', scuola_id: SEDE_B, anno_id: A2, school_type: 'primaria' },
    { id: SEZ_1A_B_2728, name: '1A', scuola_id: SEDE_B, anno_id: A3, school_type: 'primaria' },
]
// stesse sezioni, come le ha un database senza `anno_id` (la CI)
const sezioniSenzaAnno = (): Riga[] =>
    sezioni().map((s) => {
        const copia = { ...s }
        delete copia.anno_id
        return copia
    })

const req = (url: string, anno?: string) =>
    new NextRequest(`http://localhost${url}`, anno ? { headers: { cookie: `anno_attivo=${anno}` } } : undefined)

const idsDi = (corpo: unknown): string[] => {
    const lista = Array.isArray(corpo)
        ? corpo
        : ((corpo as { data?: unknown }).data as unknown[] | undefined) ?? []
    return (lista as { id?: string }[]).map((s) => s.id as string).filter(Boolean).sort()
}

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.mie = []
    h.errori = {}
    h.attivoPerSede = { [SEDE_A]: S2A, [SEDE_B]: S2B }
    h.db = {
        sections: sezioni(),
        anni_sede: anniSede(),
        utenti: [{ id: SEG, ruolo: 'admin', role: 'admin' }],
        utenti_sezioni: [],
        utenti_scuole: [],
        schools: [{ id: SEDE_A, nome: 'Sede A' }],
        alunni: [],
    }
})

describe('GET /api/admin/sections · l\'elenco è di UN anno', () => {
    it('senza cookie: solo le sezioni dell\'anno attivo (due «1A» di anni diversi non si mescolano)', async () => {
        const res = await SEZIONI_GET(req('/api/admin/sections'))
        expect(res.status).toBe(200)
        expect(idsDi(await res.json())).toEqual([SEZ_1A_2627])
    })

    it('con il cookie dell\'anno scelto (2027/28): solo quelle di quell\'anno', async () => {
        const res = await SEZIONI_GET(req('/api/admin/sections', A3))
        expect(res.status).toBe(200)
        expect(idsDi(await res.json())).toEqual([SEZ_1A_2728, SEZ_2B_2728].sort())
    })

    it('con più sedi attive il filtro d\'anno vale per tutte', async () => {
        h.attive = [SEDE_A, SEDE_B]
        const res = await SEZIONI_GET(req('/api/admin/sections', A3))
        expect(idsDi(await res.json())).toEqual([SEZ_1A_2728, SEZ_2B_2728, SEZ_1A_B_2728].sort())
    })

    it('un anno nel cookie che la sede non ha → 403 ANNO_NON_ACCESSIBILE', async () => {
        const res = await SEZIONI_GET(req('/api/admin/sections', 'a9999999-9999-4999-8999-999999999999'))
        expect(res.status).toBe(403)
    })
})

describe('docenti e genitori: sempre l\'anno attivo, il cookie si ignora', () => {
    it('un docente con il cookie del 2027/28 vede le sezioni dell\'anno attivo (scoped)', async () => {
        h.ruolo = 'educator'
        h.mie = [SEZ_1A_2627, SEZ_1A_2728]
        const res = await SCOPED_GET(req('/api/admin/sections/scoped', A3))
        expect(res.status).toBe(200)
        const gruppi = (await res.json()).data as { sezioni: { id: string }[] }[]
        expect(gruppi.flatMap((g) => g.sezioni.map((s) => s.id))).toEqual([SEZ_1A_2627])
    })

    it('un docente nel 2027/28 chiesto esplicitamente non lo vede: resolveAnnoLetturaElenco ignora il cookie', async () => {
        h.ruolo = 'educator'
        const res = await PRIMARIA_SEZIONI_GET(req('/api/primaria/sezioni', A3))
        expect(res.status).toBe(200)
        expect(idsDi(await res.json())).toEqual([SEZ_1A_2627])
    })

    it('la segreteria con lo stesso cookie vede il 2027/28 (scoped)', async () => {
        const res = await SCOPED_GET(req('/api/admin/sections/scoped', A3))
        const gruppi = (await res.json()).data as { sezioni: { id: string }[] }[]
        expect(gruppi.flatMap((g) => g.sezioni.map((s) => s.id)).sort()).toEqual([SEZ_1A_2728, SEZ_2B_2728].sort())
    })
})

describe('le altre liste filtrano per anno', () => {
    it('admin/search trova «1A» una volta sola, quella dell\'anno scelto', async () => {
        const res = await SEARCH_GET(req('/api/admin/search?q=1A', A3))
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect((corpo.data.sezioni as { id: string }[]).map((s) => s.id)).toEqual([SEZ_1A_2728])
    })

    it('educator-sections (admin) elenca le sezioni dell\'anno scelto', async () => {
        h.ruolo = 'admin'
        const res = await EDUCATOR_GET(req('/api/educator-sections', A3))
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect((corpo.sections as { id: string }[]).map((s) => s.id).sort()).toEqual([SEZ_1A_2728, SEZ_2B_2728].sort())
    })

    it('primaria/classi (segreteria) elenca le classi dell\'anno attivo', async () => {
        const res = await PRIMARIA_CLASSI_GET(req('/api/primaria/classi'))
        expect(res.status).toBe(200)
        expect(idsDi(await res.json())).toEqual([SEZ_1A_2627])
    })

    it('tasks/meta propone i nomi dell\'anno scelto, senza doppioni', async () => {
        const res = await TASKS_META_GET(req('/api/tasks/meta', A3))
        expect(res.status).toBe(200)
        expect((await res.json()).classes).toEqual(['1A', '2B'])
    })
})

describe('database senza lo schema dell\'anno (la CI): niente filtro, comportamento di prima', () => {
    beforeEach(() => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        h.db.sections = sezioniSenzaAnno()
    })

    it('admin/sections elenca tutto, senza errore', async () => {
        const res = await SEZIONI_GET(req('/api/admin/sections'))
        expect(res.status).toBe(200)
        expect(idsDi(await res.json())).toHaveLength(3) // sede A: tre sezioni
    })

    it('scoped, search, educator-sections, primaria/sezioni, primaria/classi e tasks/meta rispondono 200', async () => {
        h.ruolo = 'admin'
        h.mie = [SEZ_1A_2627]
        for (const [gestore, url] of [
            [SCOPED_GET, '/api/admin/sections/scoped'],
            [SEARCH_GET, '/api/admin/search?q=1A'],
            [EDUCATOR_GET, '/api/educator-sections'],
            [PRIMARIA_SEZIONI_GET, '/api/primaria/sezioni'],
            [PRIMARIA_CLASSI_GET, '/api/primaria/classi'],
            [TASKS_META_GET, '/api/tasks/meta'],
        ] as const) {
            const res = await (gestore as (r: NextRequest) => Promise<Response>)(req(url))
            expect(res.status, url).toBe(200)
        }
        const classi = await (await PRIMARIA_CLASSI_GET(req('/api/primaria/classi'))).json()
        expect(idsDi(classi)).toHaveLength(3)
    })

    it('le ricerche per nome non filtrano (sezioniDiNome, classiMancantiNellaSede, assertClasseNomeInScope)', async () => {
        const db = nuovoFinto()
        expect(await sezioniDiNome(db, '1A', [SEDE_A])).toHaveLength(2)
        expect(await classiMancantiNellaSede(db as never, SEDE_A, ['1A', '2B'])).toEqual({ ok: true, mancanti: [] })
        const utente = { id: SEG, role: 'segreteria', scuola_id: SEDE_A } as never
        expect(await assertClasseNomeInScope(db, utente, '1A')).toBeNull()
    })
})

describe('le ricerche per NOME risolvono sull\'anno attivo', () => {
    it('sezioniDiNome: «1A» della sede A è una sola, quella dell\'anno attivo', async () => {
        expect(await sezioniDiNome(nuovoFinto(), '1A', [SEDE_A])).toEqual([SEZ_1A_2627])
    })

    it('sezioniDiNome su due sedi: una per sede, ciascuna dell\'anno attivo', async () => {
        expect((await sezioniDiNome(nuovoFinto(), '1A', [SEDE_A, SEDE_B])).sort()).toEqual([SEZ_1A_2627, SEZ_1A_B_2627].sort())
    })

    it('sezioniDiNome: un nome che esiste solo nell\'anno futuro non si risolve', async () => {
        expect(await sezioniDiNome(nuovoFinto(), '2B', [SEDE_A])).toEqual([])
    })

    it('se cambia l\'anno attivo cambia la sezione risolta', async () => {
        h.attivoPerSede = { [SEDE_A]: S3A, [SEDE_B]: S3B }
        expect(await sezioniDiNome(nuovoFinto(), '1A', [SEDE_A])).toEqual([SEZ_1A_2728])
    })

    it('assertClasseNomeInScope: la classe del solo anno futuro è fuori dal plesso (403)', async () => {
        const utente = { id: SEG, role: 'segreteria', scuola_id: SEDE_A } as never
        expect(await assertClasseNomeInScope(nuovoFinto(), utente, '1A')).toBeNull()
        const rifiuto = (await assertClasseNomeInScope(nuovoFinto(), utente, '2B')) as NextResponse
        expect(rifiuto.status).toBe(403)
    })

    it('classeEsisteInOgniSede: «2B» esiste solo nel 2027/28, quindi oggi manca', async () => {
        const ok = await classeEsisteInOgniSede(nuovoFinto(), '1A', [SEDE_A, SEDE_B], 'test')
        expect(ok).toBeNull()
        const no = await classeEsisteInOgniSede(nuovoFinto(), '2B', [SEDE_A], 'test')
        expect(no?.status).toBe(400)
    })
})

describe('classiMancantiNellaSede · il target di un avviso si valida sull\'anno attivo', () => {
    it('una classe che esiste solo nell\'anno futuro è «mancante»: l\'avviso non raggiungerebbe nessuno', async () => {
        const esito = await classiMancantiNellaSede(nuovoFinto() as never, SEDE_A, ['1A', '2B'])
        expect(esito).toEqual({ ok: true, mancanti: ['2B'] })
    })

    it('una classe dell\'anno attivo c\'è, anche se esiste omonima nell\'anno futuro', async () => {
        const esito = await classiMancantiNellaSede(nuovoFinto() as never, SEDE_A, ['1A'])
        expect(esito).toEqual({ ok: true, mancanti: [] })
    })

    it('un guasto di lettura resta un errore, non «nessuna classe»', async () => {
        h.errori = { sections: { code: '57014', message: 'timeout' } }
        const esito = await classiMancantiNellaSede(nuovoFinto() as never, SEDE_A, ['1A'])
        expect(esito.ok).toBe(false)
    })
})
