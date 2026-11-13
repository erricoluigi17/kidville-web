import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * COMPITO 4.9.3 · LA CORREZIONE DI UN ANNO CHIUSO, SULLA ROUTE `POST /api/admin/primaria/scrutinio-periodi`.
 *
 * Il flusso a due tempi, con `resolveAnnoScrittura` e il database finto VERI (sono finti solo il gate di ruolo e il client):
 *  1. senza `correzione`, su un anno `chiuso` e a guardia accesa, lo staff riceve 409 `ANNO_CHIUSO` con `correzione_possibile: true`;
 *  2. con `correzione: { motivo }` la stessa richiesta passa e lascia un gettone `correzione` col motivo in `correzioni_anno_chiuso`;
 *  3. su un anno `in_chiusura` il gettone `agosto` si crea da sé: nessun dialogo, nessun motivo;
 *  4. il MOTIVO non compare in nessuna chiamata al logger (e il logger ha visto almeno una chiamata: l'assenza non è un verde falso).
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    intestazioni: [] as Array<Record<string, string>>,
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
    return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
// Il finto genera id «finto-N», che non sono uuid: `conGettone` (vero) rifiuta un header che non lo è. Ai gettoni diamo un uuid
// vero, come farebbe il database; il resto del finto resta quello di tutti i test.
const client = () => {
    const c = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    const from = c.from.bind(c)
    ;(c as unknown as { from: unknown }).from = (tabella: string) => {
        const b = from(tabella)
        if (tabella !== 'correzioni_anno_chiuso') return b
        const insert = b.insert.bind(b)
        b.insert = (righe: Riga | Riga[]) =>
            insert((Array.isArray(righe) ? righe : [righe]).map((r) => ({ id: crypto.randomUUID(), ...r })))
        return b
    }
    return c
}
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => client(),
    // Il client con l'header dei gettoni: stesso database finto, e si ricorda cosa è stato mandato nell'header.
    createAdminClientConHeader: async (intestazioni: Record<string, string>) => {
        h.intestazioni.push(intestazioni)
        return client()
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST } from '@/app/api/admin/primaria/scrutinio-periodi/route'

const SEG = '20000000-0000-4000-8000-000000000001'
const A1 = 'a1111111-1111-4111-8111-111111111111' // 2025/26, chiuso
const A2 = 'a2222222-2222-4222-8222-222222222222' // 2026/27, corrente
const S1 = 'b1111111-1111-4111-8111-111111111111'
const S2 = 'b2222222-2222-4222-8222-222222222222'

const MOTIVO = 'rettifica del periodo dopo lo scrutinio finale XQZ-SEGRETO'

const post = (b: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/primaria/scrutinio-periodi', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )
const corpo = (over: Riga = {}): Riga => ({ annoScolastico: '2025/26', nome: 'Primo quadrimestre', ...over })
const gettoni = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'correzioni_anno_chiuso' && s.operazione === 'insert')
const periodi = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'scrutinio_periodi' && s.operazione === 'insert')
const tuttoIlLog = () => JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.intestazioni = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        scrutinio_periodi: [],
        utenti_scuole: [],
        correzioni_anno_chiuso: [],
        anno_regole: [{ guardia_attiva: true }],
        anni_scolastici: [
            { id: A1, etichetta: '2025/2026', etichetta_breve: '2025/26' },
            { id: A2, etichetta: '2026/2027', etichetta_breve: '2026/27' },
        ],
        anni_sede: [
            { id: S1, scuola_id: SEDE_A, anno_id: A1, stato: 'chiuso', domande_aperte: false },
            { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
        ],
    }
})

describe('POST scrutinio-periodi · la correzione di un anno chiuso', () => {
    it('staff, anno chiuso, guardia accesa, senza correzione → 409 ANNO_CHIUSO con `correzione_possibile`', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true })
        expect(h.scritture).toEqual([])
    })

    it('il 409 dice QUALE anno si corregge (`etichetta`), così il dialogo non resta anonimo', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2025/26' })
    })

    it('un motivo troppo corto è un 400 con il suo codice `MOTIVO_OBBLIGATORIO` (non un «Dati non validi» muto), senza eco del motivo', async () => {
        const res = await post(corpo({ correzione: { motivo: 'XQZ-cor' } }))
        expect(res.status).toBe(400)
        const j = await res.json()
        expect(j.codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(JSON.stringify(j)).not.toContain('XQZ-cor')
    })

    it('con `correzione` → 201, un gettone `correzione` col motivo, e la scrittura parte col gettone nell’header', async () => {
        const res = await post(corpo({ correzione: { motivo: MOTIVO } }))
        expect(res.status).toBe(201)
        expect(gettoni()).toHaveLength(1)
        expect(gettoni()[0].valori[0]).toMatchObject({ codice: 'correzione', motivo: MOTIVO, anno_sede_id: S1, utente_id: SEG })
        expect(periodi()).toHaveLength(1)
        expect(h.intestazioni).toHaveLength(1)
        expect(h.intestazioni[0]['x-kidville-correzione']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('un motivo di 7 caratteri → 400 e nessun gettone, nessuna scrittura', async () => {
        const res = await post(corpo({ correzione: { motivo: '1234567' } }))
        expect(res.status).toBe(400)
        expect(h.scritture).toEqual([])
    })

    it('un motivo di 8 caratteri passa; gli spazi ai bordi non fanno lunghezza', async () => {
        const corto = await post(corpo({ correzione: { motivo: '   1234567   ' } }))
        expect(corto.status).toBe(400)
        const ok = await post(corpo({ correzione: { motivo: '  12345678  ' } }))
        expect(ok.status).toBe(201)
        expect(gettoni()[0].valori[0]).toMatchObject({ motivo: '12345678' })
    })

    it('anno `in_chiusura` → 201 col gettone `agosto`, senza motivo e senza dialogo', async () => {
        h.db.anni_sede[0].stato = 'in_chiusura'
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(gettoni()).toHaveLength(1)
        expect(gettoni()[0].valori[0]).toMatchObject({ codice: 'agosto' })
        expect(gettoni()[0].valori[0]).not.toHaveProperty('motivo')
    })

    it('anno corrente: la `correzione` mandata a sproposito non crea nessun gettone', async () => {
        const res = await post(corpo({ annoScolastico: '2026/27', correzione: { motivo: MOTIVO } }))
        expect(res.status).toBe(201)
        expect(gettoni()).toEqual([])
    })

    it('guardia spenta: la scrittura di oggi passa senza dialogo (nessun 409, nessun gettone)', async () => {
        h.db.anno_regole = [{ guardia_attiva: false }]
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(gettoni()).toEqual([])
    })

    it('il MOTIVO non compare in nessun log, e il log ha visto qualcosa (l’assenza non è un verde falso)', async () => {
        const res = await post(corpo({ correzione: { motivo: MOTIVO } }))
        expect(res.status).toBe(201)
        expect(h.logEvento.mock.calls.length + h.logErrore.mock.calls.length).toBeGreaterThan(0)
        expect(tuttoIlLog()).not.toContain('XQZ-SEGRETO')
        expect(tuttoIlLog()).not.toContain(MOTIVO)
    })

    it('anche quando il gettone non si crea il motivo non esce nel log (solo il codice di Postgres)', async () => {
        h.errori = { 'correzioni_anno_chiuso:insert': { code: '23514', message: `Failing row contains (${MOTIVO})` } }
        const res = await post(corpo({ correzione: { motivo: MOTIVO } }))
        expect(res.status).toBe(500)
        expect(h.logEvento.mock.calls.length).toBeGreaterThan(0)
        expect(tuttoIlLog()).not.toContain('XQZ-SEGRETO')
    })
})
