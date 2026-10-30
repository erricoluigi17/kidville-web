import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * `GET /api/admin/crm/persone?scuolaId=…` · chi, in una sede, può ricevere una famiglia.
 *
 * Il gate di ruolo e `resolveScuoleAttive` (quali sedi ha l'utente) sono finti; `restringiSedi` — la
 * funzione che decide il 403 sulla sede chiesta — è quella VERA, e il database è il finto che applica
 * i filtri: un docente deve prendersi 403, la segreteria di un'altra sede deve prendersi 403, e
 * l'elenco della propria sede non deve contenere nessuno dell'altra.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    guasto: false as false | true | string,
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: 'u-1', role: h.ruolo, scuola_id: h.attive[0] ?? null } })
    },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
// Il database è il finto che filtra davvero; solo il guasto di lettura dell'elenco si finge, perché
// `personeDellaSede` lo lascia salire (il finto non sa far fallire una sola delle sue letture).
vi.mock('@/lib/crm/accesso', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/crm/accesso')>()
    return {
        ...vero,
        personeDellaSede: (...a: Parameters<typeof vero.personeDellaSede>) => {
            if (h.guasto) throw Object.assign(new Error('giù'), { code: h.guasto === true ? '08006' : h.guasto })
            return vero.personeDellaSede(...a)
        },
    }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => creaFintoSupabase(h.db as DBFinto),
}))

import { GET } from '@/app/api/admin/crm/persone/route'

const SEG_A = '20000000-0000-4000-8000-00000000000a'
const SEG_B = '20000000-0000-4000-8000-00000000000b'

const richiesta = (query = '') => new NextRequest(`http://localhost/api/admin/crm/persone${query}`)

beforeEach(() => {
    h.guasto = false
    h.ruolo = 'segreteria'
    h.attive = [SEDE_A]
    h.db = {
        utenti: [
            { id: SEG_A, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: SEG_B, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
        ],
        utenti_scuole: [],
    }
})

describe('GET /api/admin/crm/persone', () => {
    it('docente → 403', async () => {
        h.ruolo = 'educator'
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(403)
    })

    it('il coordinatore non è fra i ruoli del CRM → 403', async () => {
        h.ruolo = 'coordinator'
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(403)
    })

    it('segreteria su un’altra sede → 403', async () => {
        const res = await GET(richiesta(`?scuolaId=${SEDE_B}`))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('segreteria sulla propria → elenco', async () => {
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(200)
        const corpo = await res.json()
        expect(corpo.data).toEqual([{ id: SEG_A, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria' }])
    })

    it('la propria sede in maiuscolo non è un diniego', async () => {
        const res = await GET(richiesta(`?scuolaId=${SEDE_A.toUpperCase()}`))
        expect(res.status).toBe(200)
        expect((await res.json()).data).toHaveLength(1)
    })

    it('senza scuolaId → 400: la sede si dichiara, non si indovina', async () => {
        const res = await GET(richiesta())
        expect(res.status).toBe(400)
    })

    it('senza nessuna sede attiva → 403', async () => {
        h.attive = []
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(403)
    })

    it('scuolaId che non è un uuid → 400', async () => {
        const res = await GET(richiesta('?scuolaId=non-un-uuid'))
        expect(res.status).toBe(400)
    })

    it('guasto del database → 500 CRM_OPERAZIONE_NON_RIUSCITA', async () => {
        h.guasto = true
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(500)
        expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    })

    it('le tabelle assenti → 503 CRM_NON_INSTALLATO', async () => {
        h.guasto = 'PGRST205'
        const res = await GET(richiesta(`?scuolaId=${SEDE_A}`))
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    })
})
