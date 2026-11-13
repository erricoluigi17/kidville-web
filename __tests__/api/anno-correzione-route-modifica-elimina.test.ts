import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * COMPITO 4.9.3 (giro 1, S6) · LA CORREZIONE DI UN ANNO CHIUSO SU PATCH E DELETE.
 *
 * Il POST di `scrutinio-periodi` sapeva già chiedere il gettone; PATCH e DELETE della stessa route, e `chiudi`/`proroga`/DELETE di
 * `votazioni/[id]`, no: su un anno chiuso e a guardia accesa lo staff non aveva né il dialogo né un 409 da superare. Qui, con
 * `resolveAnnoScrittura` e il database finto VERI (finti solo il gate di ruolo e il client):
 *  1. senza `correzione`, su un anno `chiuso`: 409 `ANNO_CHIUSO` con `correzione_possibile: true` e `etichetta`, e NESSUNA scrittura;
 *  2. con `correzione: { motivo }` (nel corpo JSON, anche per il DELETE): la scrittura passa, lascia un gettone col motivo e parte col
 *     gettone nell'header;
 *  3. sull'anno corrente (o su una riga senza anno) niente gettone, niente dialogo: com'era;
 *  4. un motivo che non regge è 400 `MOTIVO_OBBLIGATORIO`, senza scritture, e il motivo non compare in nessun log.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
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
// Ai gettoni diamo un uuid vero (il finto genera «finto-N»), come farebbe il database.
const client = () => {
    const c = creaFintoSupabase(h.db as DBFinto, [], { errori: {}, scritture: h.scritture as Scrittura[] })
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
    createAdminClientConHeader: async (intestazioni: Record<string, string>) => {
        h.intestazioni.push(intestazioni)
        return client()
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { DELETE as ELIMINA_PERIODO, PATCH as MODIFICA_PERIODO } from '@/app/api/admin/primaria/scrutinio-periodi/route'
import { DELETE as ELIMINA_VOTAZIONE, PATCH as MODIFICA_VOTAZIONE } from '@/app/api/admin/votazioni/[id]/route'

const SEG = '20000000-0000-4000-8000-000000000001'
const A1 = 'a1111111-1111-4111-8111-111111111111' // 2025/26, chiuso
const A2 = 'a2222222-2222-4222-8222-222222222222' // 2026/27, corrente
const S1 = 'b1111111-1111-4111-8111-111111111111'
const S2 = 'b2222222-2222-4222-8222-222222222222'
const P_CHIUSO = 'c1111111-1111-4111-8111-111111111111'
const P_CORRENTE = 'c2222222-2222-4222-8222-222222222222'
const V_CHIUSA = '90000000-0000-4000-8000-000000000001'
const V_CORRENTE = '90000000-0000-4000-8000-000000000002'
const V_STORICA = '90000000-0000-4000-8000-000000000003'

const MOTIVO = 'rettifica dopo lo scrutinio finale XQZ-SEGRETO'

const tra = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()

const reqPeriodi = (metodo: 'PATCH' | 'DELETE', corpo?: unknown, query = '') =>
    new NextRequest(`http://localhost/api/admin/primaria/scrutinio-periodi${query}`, {
        method: metodo,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
    })
const modificaPeriodo = (corpo: unknown) => MODIFICA_PERIODO(reqPeriodi('PATCH', corpo))
const eliminaPeriodo = (id: string, corpo?: unknown) => ELIMINA_PERIODO(reqPeriodi('DELETE', corpo, `?id=${id}`))

const reqVot = (id: string, metodo: 'PATCH' | 'DELETE', corpo?: unknown) =>
    new NextRequest(`http://localhost/api/admin/votazioni/${id}`, {
        method: metodo,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
    })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const modificaVotazione = (id: string, corpo: unknown) => MODIFICA_VOTAZIONE(reqVot(id, 'PATCH', corpo), ctx(id))
const eliminaVotazione = (id: string, corpo?: unknown) => ELIMINA_VOTAZIONE(reqVot(id, 'DELETE', corpo), ctx(id))

const gettoni = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'correzioni_anno_chiuso' && s.operazione === 'insert')
const scrittureSu = (tabella: string, op: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === op)
const tuttoIlLog = () => JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])

function vot(id: string, annoId: string | null, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        titolo: 'Titolo',
        scadenza: tra(7),
        chiusa_il: null,
        rappresentante_istituto: false,
        creata_da: SEG,
        creata_il: '2026-10-01T08:00:00.000Z',
        aggiornata_da: null,
        aggiornata_il: null,
        ...(annoId ? { anno_id: annoId } : {}),
        ...over,
    }
}

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.scritture = []
    h.intestazioni = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        scrutinio_periodi: [
            { id: P_CHIUSO, scuola_id: SEDE_A, anno_id: A1, anno_scolastico: '2025/26', nome: 'Primo', ordine: 1, data_inizio: null, data_fine: null, attivo: true },
            { id: P_CORRENTE, scuola_id: SEDE_A, anno_id: A2, anno_scolastico: '2026/27', nome: 'Primo', ordine: 1, data_inizio: null, data_fine: null, attivo: true },
        ],
        scrutini: [],
        votazioni: [vot(V_CHIUSA, A1), vot(V_CORRENTE, A2), vot(V_STORICA, null)],
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

describe('PATCH scrutinio-periodi · la correzione di un anno chiuso', () => {
    it('senza correzione → 409 ANNO_CHIUSO con `correzione_possibile` e l’etichetta dell’anno; nessuna scrittura', async () => {
        const res = await modificaPeriodo({ id: P_CHIUSO, attivo: false })
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2025/26' })
        expect(h.scritture).toEqual([])
    })

    it('con `correzione` → 200, un gettone col motivo, e l’update parte col gettone nell’header', async () => {
        const res = await modificaPeriodo({ id: P_CHIUSO, attivo: false, correzione: { motivo: MOTIVO } })
        expect(res.status).toBe(200)
        expect(gettoni()).toHaveLength(1)
        expect(gettoni()[0].valori[0]).toMatchObject({ codice: 'correzione', motivo: MOTIVO, anno_sede_id: S1, utente_id: SEG })
        expect(scrittureSu('scrutinio_periodi', 'update')).toHaveLength(1)
        expect(h.intestazioni).toHaveLength(1)
        expect(h.intestazioni[0]['x-kidville-correzione']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('un motivo di 7 caratteri → 400 MOTIVO_OBBLIGATORIO, nessun gettone, nessuna scrittura, nessuna eco', async () => {
        const res = await modificaPeriodo({ id: P_CHIUSO, attivo: false, correzione: { motivo: 'XQZ-cor' } })
        expect(res.status).toBe(400)
        const j = await res.json()
        expect(j.codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(JSON.stringify(j)).not.toContain('XQZ-cor')
        expect(h.scritture).toEqual([])
    })

    it('periodo dell’anno corrente: nessun gettone, nessun dialogo (anche con una `correzione` mandata a sproposito)', async () => {
        const res = await modificaPeriodo({ id: P_CORRENTE, attivo: false, correzione: { motivo: MOTIVO } })
        expect(res.status).toBe(200)
        expect(gettoni()).toEqual([])
        expect(h.intestazioni).toEqual([])
    })

    it('il MOTIVO non compare in nessun log, e il log ha visto qualcosa', async () => {
        await modificaPeriodo({ id: P_CHIUSO, attivo: false, correzione: { motivo: MOTIVO } })
        expect(h.logEvento.mock.calls.length + h.logErrore.mock.calls.length).toBeGreaterThan(0)
        expect(tuttoIlLog()).not.toContain('XQZ-SEGRETO')
    })
})

describe('DELETE scrutinio-periodi · la correzione di un anno chiuso (nel corpo JSON)', () => {
    it('senza correzione e senza corpo → 409 con `correzione_possibile`; il periodo c’è ancora', async () => {
        const res = await eliminaPeriodo(P_CHIUSO)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2025/26' })
        expect(h.scritture).toEqual([])
    })

    it('con `correzione` nel corpo → 200, un gettone, e il periodo è cancellato col gettone nell’header', async () => {
        const res = await eliminaPeriodo(P_CHIUSO, { correzione: { motivo: MOTIVO } })
        expect(res.status).toBe(200)
        expect(gettoni()).toHaveLength(1)
        expect(gettoni()[0].valori[0]).toMatchObject({ codice: 'correzione', motivo: MOTIVO })
        expect(scrittureSu('scrutinio_periodi', 'delete')).toHaveLength(1)
        expect(h.intestazioni[0]['x-kidville-correzione']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('un corpo `{}` (il primo invio della schermata) si comporta come nessun corpo', async () => {
        const res = await eliminaPeriodo(P_CHIUSO, {})
        expect(res.status).toBe(409)
    })

    it('un motivo troppo corto → 400 MOTIVO_OBBLIGATORIO e nessuna scrittura', async () => {
        const res = await eliminaPeriodo(P_CHIUSO, { correzione: { motivo: 'corto' } })
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(h.scritture).toEqual([])
    })

    it('periodo dell’anno corrente: si elimina come prima, senza gettone', async () => {
        const res = await eliminaPeriodo(P_CORRENTE)
        expect(res.status).toBe(200)
        expect(gettoni()).toEqual([])
    })
})

describe('PATCH votazioni/[id] · `chiudi` e `proroga` su un anno chiuso', () => {
    it('chiudi senza correzione → 409 con `correzione_possibile` e l’etichetta; la votazione resta aperta', async () => {
        const res = await modificaVotazione(V_CHIUSA, { azione: 'chiudi' })
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2025/26' })
        expect(h.scritture).toEqual([])
    })

    it('chiudi con correzione → 200, un gettone col motivo, la votazione è chiusa', async () => {
        const res = await modificaVotazione(V_CHIUSA, { azione: 'chiudi', correzione: { motivo: MOTIVO } })
        expect(res.status).toBe(200)
        expect(gettoni()).toHaveLength(1)
        expect(gettoni()[0].valori[0]).toMatchObject({ codice: 'correzione', motivo: MOTIVO, anno_sede_id: S1 })
        expect(scrittureSu('votazioni', 'update')).toHaveLength(1)
        expect(h.intestazioni).toHaveLength(1)
    })

    it('proroga senza correzione → 409 con `correzione_possibile`; con correzione → 200', async () => {
        const scadenza = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 16)
        const prima = await modificaVotazione(V_CHIUSA, { azione: 'proroga', scadenza })
        expect(prima.status).toBe(409)
        expect(await prima.json()).toMatchObject({ correzione_possibile: true })
        const dopo = await modificaVotazione(V_CHIUSA, { azione: 'proroga', scadenza, correzione: { motivo: MOTIVO } })
        expect(dopo.status).toBe(200)
        expect(gettoni()).toHaveLength(1)
    })

    it('un motivo che non regge → 400 MOTIVO_OBBLIGATORIO, nessuna scrittura', async () => {
        const res = await modificaVotazione(V_CHIUSA, { azione: 'chiudi', correzione: { motivo: 'XQZ-cor' } })
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('MOTIVO_OBBLIGATORIO')
        expect(h.scritture).toEqual([])
    })

    it('votazione dell’anno corrente o senza anno: come prima, nessun gettone', async () => {
        expect((await modificaVotazione(V_CORRENTE, { azione: 'chiudi' })).status).toBe(200)
        expect((await modificaVotazione(V_STORICA, { azione: 'chiudi' })).status).toBe(200)
        expect(gettoni()).toEqual([])
    })

    it('il MOTIVO non compare in nessun log', async () => {
        await modificaVotazione(V_CHIUSA, { azione: 'chiudi', correzione: { motivo: MOTIVO } })
        expect(h.logEvento.mock.calls.length).toBeGreaterThan(0)
        expect(tuttoIlLog()).not.toContain('XQZ-SEGRETO')
    })
})

describe('DELETE votazioni/[id] · su un anno chiuso', () => {
    it('senza correzione → 409 con `correzione_possibile`; la votazione c’è ancora', async () => {
        const res = await eliminaVotazione(V_CHIUSA)
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2025/26' })
        expect(h.scritture).toEqual([])
    })

    it('con `correzione` nel corpo → 200, un gettone, la votazione è eliminata', async () => {
        const res = await eliminaVotazione(V_CHIUSA, { correzione: { motivo: MOTIVO } })
        expect(res.status).toBe(200)
        expect(gettoni()).toHaveLength(1)
        expect(scrittureSu('votazioni', 'delete')).toHaveLength(1)
    })

    it('votazione dell’anno corrente: si elimina come prima', async () => {
        const res = await eliminaVotazione(V_CORRENTE)
        expect(res.status).toBe(200)
        expect(gettoni()).toEqual([])
    })
})
