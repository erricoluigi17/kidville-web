import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · la disponibilità settimanale e le assenze:
 * `GET/POST /api/admin/crm/disponibilita`, `PATCH/DELETE /disponibilita/[id]`,
 * `GET/POST /api/admin/crm/indisponibilita`, `DELETE /indisponibilita/[id]`.
 *
 * Come per gli appuntamenti: gate e cookie delle sedi finti, tutto il resto vero, database finto che applica
 * i filtri ed esegue le scritture. La regola che questi test fissano è una: **ognuna modifica la PROPRIA, la
 * Direzione quella di tutte** (`403 SOLO_LA_PROPRIA`), e le chiusure di sede le gestisce qualsiasi segretaria
 * della sede. Gli orari sono di Roma; l'orologio è congelato (solo `Date`).
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    userId: '' as string,
    scuolaUtente: '' as string | null,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    /** Eseguito PRIMA della seconda `from(tabella)` (la scrittura che segue la lettura della riga). */
    corsa: null as null | { tabella: string; fa: () => void },
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: h.userId, role: h.ruolo, scuola_id: h.scuolaUtente } })
    },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const vero = creaFintoSupabase(h.db as DBFinto, [], {
            errori: h.errori as Record<string, ErrorePostgrest>,
            scritture: h.scritture as Scrittura[],
        })
        const viste: Record<string, number> = {}
        return new Proxy(vero, {
            get(bersaglio, prop, ricevitore) {
                if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
                return (tabella: string) => {
                    viste[tabella] = (viste[tabella] ?? 0) + 1
                    if (h.corsa && h.corsa.tabella === tabella && viste[tabella] === 2) h.corsa.fa()
                    return bersaglio.from(tabella)
                }
            },
        })
    },
}))

import { GET as GET_DISP, POST as POST_DISP } from '@/app/api/admin/crm/disponibilita/route'
import { PATCH as PATCH_DISP, DELETE as DELETE_DISP } from '@/app/api/admin/crm/disponibilita/[id]/route'
import { GET as GET_ASS, POST as POST_ASS } from '@/app/api/admin/crm/indisponibilita/route'
import { DELETE as DELETE_ASS } from '@/app/api/admin/crm/indisponibilita/[id]/route'

const U1 = '20000000-0000-4000-8000-000000000001' // l'utente sotto test: segreteria di SEDE_A
const U2 = '20000000-0000-4000-8000-000000000002' // una collega della stessa sede
const U_B = '20000000-0000-4000-8000-00000000000b' // segreteria di SEDE_B
const ADMIN = '20000000-0000-4000-8000-0000000000ad' // Direzione, con A e B
const F1 = '50000000-0000-4000-8000-000000000001' // fascia di U1
const F2 = '50000000-0000-4000-8000-000000000002' // fascia di U2
const F_B = '50000000-0000-4000-8000-00000000000b' // fascia di U_B (SEDE_B)
const AS1 = '60000000-0000-4000-8000-000000000001' // assenza di U1
const AS2 = '60000000-0000-4000-8000-000000000002' // assenza di U2
const AS_SEDE = '60000000-0000-4000-8000-0000000000cc' // chiusura di SEDE_A
const AS_B = '60000000-0000-4000-8000-00000000000b' // chiusura di SEDE_B

const json = (url: string, metodo: string, corpo?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
        method: metodo,
        headers: { 'content-type': 'application/json' },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const fascia = (o: Riga = {}): Riga => ({
    id: F1,
    scuola_id: SEDE_A,
    utente_id: U1,
    giorno_settimana: 1,
    ora_inizio: '09:00:00',
    ora_fine: '13:00:00',
    durata_slot_min: 45,
    valida_dal: '2026-09-01',
    valida_al: null,
    creata_il: '2026-09-01T00:00:00.000Z',
    ...o,
})
const assenza = (o: Riga = {}): Riga => ({
    id: AS1,
    scuola_id: SEDE_A,
    utente_id: U1,
    dal: '2026-11-10T23:00:00.000Z',
    al: '2026-11-12T23:00:00.000Z',
    motivo: 'ferie',
    creata_da: U1,
    creata_il: '2026-10-30T09:00:00.000Z',
    ...o,
})

const scritte = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const riga = (tabella: string, id: string) => h.db[tabella].find((r) => r.id === id)

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T07:00:00.000Z')) // lunedì 2/11, 08:00 a Roma
    h.ruolo = 'segreteria'
    h.userId = U1
    h.scuolaUtente = SEDE_A
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.corsa = null
    h.db = {
        utenti: [
            { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
            { id: ADMIN, nome: 'Dir', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_A, archiviato_il: null },
        ],
        utenti_scuole: [
            { utente_id: ADMIN, scuola_id: SEDE_A },
            { utente_id: ADMIN, scuola_id: SEDE_B },
        ],
        crm_disponibilita: [
            fascia(),
            fascia({ id: F2, utente_id: U2, giorno_settimana: 2 }),
            fascia({ id: F_B, scuola_id: SEDE_B, utente_id: U_B }),
        ],
        crm_indisponibilita: [
            assenza(),
            assenza({ id: AS2, utente_id: U2, creata_da: U2 }),
            assenza({ id: AS_SEDE, utente_id: null, motivo: 'chiusura', creata_da: U2 }),
            assenza({ id: AS_B, scuola_id: SEDE_B, utente_id: null, motivo: 'chiusura', creata_da: U_B }),
        ],
    }
})

afterEach(() => {
    vi.useRealTimers()
})

const comeAdmin = () => {
    h.ruolo = 'admin'
    h.userId = ADMIN
}

// ─────────────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/crm/disponibilita', () => {
    const url = (q = '') => `/api/admin/crm/disponibilita?scuolaId=${SEDE_A}${q}`

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await GET_DISP(json(url(), 'GET'))).status).toBe(403)
    })

    it('una sede che non è la propria → 403 SEDE_NON_ACCESSIBILE', async () => {
        const res = await GET_DISP(json(`/api/admin/crm/disponibilita?scuolaId=${SEDE_B}`, 'GET'))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('la sede è richiesta', async () => {
        expect((await GET_DISP(json('/api/admin/crm/disponibilita', 'GET'))).status).toBe(400)
    })

    it('le fasce della sede, e solo della sede', async () => {
        const { data } = await (await GET_DISP(json(url(), 'GET'))).json()
        expect(data.map((f: Riga) => f.id).sort()).toEqual([F1, F2].sort())
    })

    it('le fasce già finite non tornano; quelle che finiscono oggi o dopo sì', async () => {
        h.db.crm_disponibilita.push(
            fascia({ id: 'f-scaduta', valida_al: '2026-11-01' }),
            fascia({ id: 'f-oggi', valida_al: '2026-11-02' }),
            fascia({ id: 'f-futura', valida_dal: '2026-12-01', valida_al: '2027-01-31' }),
        )
        const { data } = await (await GET_DISP(json(url(), 'GET'))).json()
        const ids = data.map((f: Riga) => f.id)
        expect(ids).not.toContain('f-scaduta')
        expect(ids).toEqual(expect.arrayContaining(['f-oggi', 'f-futura']))
    })

    it('«scaduta» si decide col giorno di Roma: all’una di notte del 3/11 (00:30Z) quella che finiva il 2/11 è finita', async () => {
        vi.setSystemTime(new Date('2026-11-02T23:30:00.000Z')) // martedì 3/11, 00:30 a Roma
        h.db.crm_disponibilita.push(fascia({ id: 'f-ieri', valida_al: '2026-11-02' }))
        const { data } = await (await GET_DISP(json(url(), 'GET'))).json()
        expect(data.map((f: Riga) => f.id)).not.toContain('f-ieri')
    })

    it('si può chiedere solo quelle di una persona', async () => {
        const { data } = await (await GET_DISP(json(url(`&utenteId=${U2}`), 'GET'))).json()
        expect(data.map((f: Riga) => f.id)).toEqual([F2])
    })

    it('un guasto di lettura → 500', async () => {
        h.errori = { 'crm_disponibilita:select': { code: '08006' } }
        expect((await GET_DISP(json(url(), 'GET'))).status).toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/crm/disponibilita', () => {
    const corpo = (o: Record<string, unknown> = {}) => ({ giornoSettimana: 3, oraInizio: '14:00', oraFine: '17:30', ...o })
    const invia = (o?: Record<string, unknown>) => POST_DISP(json('/api/admin/crm/disponibilita', 'POST', corpo(o)))

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await invia()).status).toBe(403)
    })

    it('la propria fascia → 201: sede, persona, durata 45 di default, valida da oggi senza fine', async () => {
        const res = await invia()
        expect(res.status).toBe(201)
        expect((await res.json()).id).toBeTruthy()
        expect(scritte('crm_disponibilita', 'insert')[0].valori[0]).toMatchObject({
            scuola_id: SEDE_A,
            utente_id: U1,
            giorno_settimana: 3,
            ora_inizio: '14:00',
            ora_fine: '17:30',
            durata_slot_min: 45,
            valida_dal: '2026-11-02',
            valida_al: null,
        })
    })

    it('«da oggi» è il giorno di Roma, non quello di UTC: all’una di notte del 25/10 (23:30Z del 24) è il 25', async () => {
        vi.setSystemTime(new Date('2026-10-24T23:30:00.000Z'))
        await invia()
        expect(scritte('crm_disponibilita', 'insert')[0].valori[0].valida_dal).toBe('2026-10-25')
    })

    it('durata e periodo si possono dire', async () => {
        await invia({ durataSlotMin: 30, validaDal: '2026-12-01', validaAl: '2027-06-30' })
        expect(scritte('crm_disponibilita', 'insert')[0].valori[0]).toMatchObject({
            durata_slot_min: 30,
            valida_dal: '2026-12-01',
            valida_al: '2027-06-30',
        })
    })

    it('POST di una fascia di una collega da una segreteria → 403 SOLO_LA_PROPRIA, e non si scrive', async () => {
        const res = await invia({ utenteId: U2 })
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SOLO_LA_PROPRIA')
        expect(scritte('crm_disponibilita', 'insert')).toHaveLength(0)
    })

    it('fatta dall’admin → 201 per la collega', async () => {
        comeAdmin()
        const res = await invia({ utenteId: U2, scuolaId: SEDE_A })
        expect(res.status).toBe(201)
        expect(scritte('crm_disponibilita', 'insert')[0].valori[0]).toMatchObject({ utente_id: U2, scuola_id: SEDE_A })
    })

    it('l’admin con due sedi e nessuna indicata → 400 (la sede non si indovina)', async () => {
        comeAdmin()
        h.attive = [SEDE_A, SEDE_B]
        const res = await invia({ utenteId: U2 })
        expect(res.status).toBe(400)
        expect(scritte('crm_disponibilita', 'insert')).toHaveLength(0)
    })

    it('l’admin scrive nella sede dichiarata, anche se non è la prima', async () => {
        comeAdmin()
        const res = await invia({ utenteId: U_B, scuolaId: SEDE_B })
        expect(res.status).toBe(201)
        expect(scritte('crm_disponibilita', 'insert')[0].valori[0].scuola_id).toBe(SEDE_B)
    })

    it('una persona che non è della sede dichiarata → 422 PERSONA_NON_DELLA_SEDE', async () => {
        comeAdmin()
        const res = await invia({ utenteId: U_B, scuolaId: SEDE_A })
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('PERSONA_NON_DELLA_SEDE')
        expect(scritte('crm_disponibilita', 'insert')).toHaveLength(0)
    })

    it('una sede che non è la propria → 403', async () => {
        const res = await invia({ scuolaId: SEDE_B })
        expect(res.status).toBe(403)
        expect(scritte('crm_disponibilita', 'insert')).toHaveLength(0)
    })

    it.each([
        ['fine uguale all’inizio', { oraInizio: '10:00', oraFine: '10:00' }],
        ['fine prima dell’inizio', { oraInizio: '14:00', oraFine: '09:00' }],
        ['ora senza lo zero', { oraInizio: '9:00' }],
        ['ora inesistente', { oraFine: '25:00' }],
        ['giorno 0', { giornoSettimana: 0 }],
        ['giorno 8', { giornoSettimana: 8 }],
        ['giorno non intero', { giornoSettimana: 1.5 }],
        ['slot di 10 minuti', { durataSlotMin: 10 }],
        ['slot di 300 minuti', { durataSlotMin: 300 }],
        ['periodo al contrario', { validaDal: '2026-12-01', validaAl: '2026-11-01' }],
        ['fine prima di oggi senza inizio', { validaAl: '2026-10-01' }],
        ['data inesistente', { validaDal: '2026-02-30' }],
    ])('%s → 400, e non si scrive', async (_nome, o) => {
        const res = await invia(o as Record<string, unknown>)
        expect(res.status).toBe(400)
        expect(scritte('crm_disponibilita', 'insert')).toHaveLength(0)
    })

    it('un guasto del database → 500; tabelle assenti → 503', async () => {
        h.errori = { 'crm_disponibilita:insert': { code: '08006' } }
        expect((await invia()).status).toBe(500)
        h.errori = { 'crm_disponibilita:insert': { code: 'PGRST205' } }
        expect((await invia()).status).toBe(503)
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/crm/disponibilita/[id]', () => {
    const modifica = (corpo: unknown, id = F1) => PATCH_DISP(json(`/api/admin/crm/disponibilita/${id}`, 'PATCH', corpo), ctx(id))

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await modifica({ oraFine: '12:00' })).status).toBe(403)
    })

    it('la propria fascia → 200, e cambia solo quello che si è detto', async () => {
        const res = await modifica({ oraFine: '12:00', durataSlotMin: 30 })
        expect(res.status).toBe(200)
        expect(riga('crm_disponibilita', F1)).toMatchObject({
            ora_inizio: '09:00:00',
            ora_fine: '12:00',
            durata_slot_min: 30,
            giorno_settimana: 1,
            valida_dal: '2026-09-01',
            valida_al: null,
        })
    })

    it('si può mettere una fine al periodo, e anche toglierla (null)', async () => {
        await modifica({ validaAl: '2026-12-31' })
        expect(riga('crm_disponibilita', F1)?.valida_al).toBe('2026-12-31')
        await modifica({ validaAl: null })
        expect(riga('crm_disponibilita', F1)?.valida_al).toBeNull()
    })

    it('disponibilità di una collega fatta da una segreteria → 403; fatta dall’admin → 200', async () => {
        const rifiutata = await modifica({ oraFine: '12:00' }, F2)
        expect(rifiutata.status).toBe(403)
        expect((await rifiutata.json()).codice).toBe('SOLO_LA_PROPRIA')
        expect(riga('crm_disponibilita', F2)?.ora_fine).toBe('13:00:00')

        comeAdmin()
        expect((await modifica({ oraFine: '12:00' }, F2)).status).toBe(200)
        expect(riga('crm_disponibilita', F2)?.ora_fine).toBe('12:00')
    })

    it('la fascia che ne risulta deve reggersi: una fine prima dell’inizio che c’è già → 400', async () => {
        const res = await modifica({ oraFine: '08:00' }) // l'inizio esistente è 09:00
        expect(res.status).toBe(400)
        expect(riga('crm_disponibilita', F1)?.ora_fine).toBe('13:00:00')
        expect((await modifica({ oraInizio: '14:00' })).status).toBe(400) // la fine esistente è 13:00
    })

    it('un periodo che finisce prima di iniziare, contando quello che c’è già → 400', async () => {
        expect((await modifica({ validaAl: '2026-08-31' })).status).toBe(400) // valida_dal esistente: 2026-09-01
        expect(riga('crm_disponibilita', F1)?.valida_al).toBeNull()
    })

    it('nessuna modifica, o valori senza senso → 400', async () => {
        expect((await modifica({})).status).toBe(400)
        expect((await modifica({ giornoSettimana: 9 })).status).toBe(400)
        expect((await modifica({ oraInizio: 'tardi' })).status).toBe(400)
    })

    it('una fascia di un’altra sede → 403', async () => {
        const res = await modifica({ oraFine: '12:00' }, F_B)
        expect(res.status).toBe(403)
        expect(riga('crm_disponibilita', F_B)?.ora_fine).toBe('13:00:00')
    })

    it('una fascia che non c’è → 404 ELEMENTO_NON_TROVATO', async () => {
        const res = await modifica({ oraFine: '12:00' }, '50000000-0000-4000-8000-0000000000ff')
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('ELEMENTO_NON_TROVATO')
    })

    it('tolta dalla collega fra la lettura e la scrittura → 404, non un 200 per niente', async () => {
        h.corsa = { tabella: 'crm_disponibilita', fa: () => void (h.db.crm_disponibilita = h.db.crm_disponibilita.filter((r) => r.id !== F1)) }
        expect((await modifica({ oraFine: '12:00' })).status).toBe(404)
    })

    it('l’update mira la sede oltre all’id', async () => {
        h.db.crm_disponibilita.push(fascia({ scuola_id: SEDE_B })) // stesso id, altra sede
        await modifica({ oraFine: '12:00' })
        const [u] = scritte('crm_disponibilita', 'update')
        expect(u.colpite).toHaveLength(1)
        expect(u.colpite[0].scuola_id).toBe(SEDE_A)
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/admin/crm/disponibilita/[id]', () => {
    const elimina = (id = F1) => DELETE_DISP(json(`/api/admin/crm/disponibilita/${id}`, 'DELETE'), ctx(id))

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await elimina()).status).toBe(403)
    })

    it('la propria → 200 e sparisce', async () => {
        expect((await elimina()).status).toBe(200)
        expect(riga('crm_disponibilita', F1)).toBeUndefined()
        expect(h.db.crm_disponibilita).toHaveLength(2)
    })

    it('quella di una collega: segreteria → 403 e resta; admin → 200', async () => {
        const res = await elimina(F2)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SOLO_LA_PROPRIA')
        expect(riga('crm_disponibilita', F2)).toBeDefined()

        comeAdmin()
        expect((await elimina(F2)).status).toBe(200)
        expect(riga('crm_disponibilita', F2)).toBeUndefined()
    })

    it('di un’altra sede → 403 e resta', async () => {
        expect((await elimina(F_B)).status).toBe(403)
        expect(riga('crm_disponibilita', F_B)).toBeDefined()
    })

    it('che non c’è → 404', async () => {
        const res = await elimina('50000000-0000-4000-8000-0000000000ff')
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('ELEMENTO_NON_TROVATO')
    })

    it('già tolta fra la lettura e la scrittura → 404', async () => {
        h.corsa = { tabella: 'crm_disponibilita', fa: () => void (h.db.crm_disponibilita = h.db.crm_disponibilita.filter((r) => r.id !== F1)) }
        expect((await elimina()).status).toBe(404)
    })

    it('il delete mira la sede oltre all’id', async () => {
        h.db.crm_disponibilita.push(fascia({ scuola_id: SEDE_B }))
        await elimina()
        const [d] = scritte('crm_disponibilita', 'delete')
        expect(d.colpite).toHaveLength(1)
        expect(d.colpite[0].scuola_id).toBe(SEDE_A)
        expect(h.db.crm_disponibilita.filter((r) => r.id === F1)).toHaveLength(1) // quella di SEDE_B è intatta
    })

    it('un guasto del database → 500', async () => {
        h.errori = { 'crm_disponibilita:delete': { code: '08006' } }
        expect((await elimina()).status).toBe(500)
        expect(riga('crm_disponibilita', F1)).toBeDefined()
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/crm/indisponibilita', () => {
    const url = `/api/admin/crm/indisponibilita?scuolaId=${SEDE_A}`

    it('docente → 403; un’altra sede → 403', async () => {
        h.ruolo = 'educator'
        expect((await GET_ASS(json(url, 'GET'))).status).toBe(403)
        h.ruolo = 'segreteria'
        expect((await GET_ASS(json(`/api/admin/crm/indisponibilita?scuolaId=${SEDE_B}`, 'GET'))).status).toBe(403)
    })

    it('le assenze e le chiusure della sede, non quelle di un’altra', async () => {
        const { data } = await (await GET_ASS(json(url, 'GET'))).json()
        expect(data.map((a: Riga) => a.id).sort()).toEqual([AS1, AS2, AS_SEDE].sort())
    })

    it('quelle già finite non tornano', async () => {
        h.db.crm_indisponibilita.push(assenza({ id: 'as-vecchia', dal: '2026-09-01T00:00:00.000Z', al: '2026-09-05T00:00:00.000Z' }))
        const { data } = await (await GET_ASS(json(url, 'GET'))).json()
        expect(data.map((a: Riga) => a.id)).not.toContain('as-vecchia')
    })

    it('un guasto di lettura → 500', async () => {
        h.errori = { 'crm_indisponibilita:select': { code: '08006' } }
        expect((await GET_ASS(json(url, 'GET'))).status).toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/crm/indisponibilita', () => {
    const corpo = (o: Record<string, unknown> = {}) => ({ motivo: 'ferie', dal: '2026-11-16', al: '2026-11-18', ...o })
    const invia = (o?: Record<string, unknown>) => POST_ASS(json('/api/admin/crm/indisponibilita', 'POST', corpo(o)))
    const scrittaRiga = () => scritte('crm_indisponibilita', 'insert')[0].valori[0]

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await invia()).status).toBe(403)
    })

    it('le ferie a giorni: «dal 16 al 18» comprende anche il 18, a Roma', async () => {
        const res = await invia()
        expect(res.status).toBe(201)
        expect(scrittaRiga()).toMatchObject({
            scuola_id: SEDE_A,
            utente_id: U1,
            motivo: 'ferie',
            creata_da: U1,
            dal: '2026-11-15T23:00:00.000Z', // mezzanotte del 16 a Roma (CET)
            al: '2026-11-18T23:00:00.000Z', // mezzanotte del 19: il 18 è compreso
        })
    })

    it('a cavallo del cambio dell’ora legale: dal 24 al 25/10/2026 sono 49 ore, non 48', async () => {
        await invia({ dal: '2026-10-24', al: '2026-10-25' })
        const r = scrittaRiga()
        expect(r.dal).toBe('2026-10-23T22:00:00.000Z') // mezzanotte del 24, ora legale (+02:00)
        expect(r.al).toBe('2026-10-25T23:00:00.000Z') // mezzanotte del 26, ora solare (+01:00)
        expect((Date.parse(r.al as string) - Date.parse(r.dal as string)) / 3_600_000).toBe(49)
    })

    it('un giorno solo: dal 3 al 3 copre tutto il 3', async () => {
        await invia({ dal: '2026-11-03', al: '2026-11-03' })
        expect(scrittaRiga()).toMatchObject({ dal: '2026-11-02T23:00:00.000Z', al: '2026-11-03T23:00:00.000Z' })
    })

    it('con gli orari: dalle 9 alle 13 di Roma', async () => {
        await invia({ dal: '2026-11-03T09:00', al: '2026-11-03T13:00', motivo: 'altro' })
        expect(scrittaRiga()).toMatchObject({ dal: '2026-11-03T08:00:00.000Z', al: '2026-11-03T12:00:00.000Z', motivo: 'altro' })
    })

    it('chiusura di sede: utenteId null, la può inserire qualsiasi segretaria della sede', async () => {
        const res = await invia({ utenteId: null, motivo: 'chiusura' })
        expect(res.status).toBe(201)
        expect(scrittaRiga()).toMatchObject({ scuola_id: SEDE_A, utente_id: null, motivo: 'chiusura' })
    })

    it('una assenza di tutta la sede che non è una chiusura → 400', async () => {
        const res = await invia({ utenteId: null, motivo: 'ferie' })
        expect(res.status).toBe(400)
        expect(scritte('crm_indisponibilita', 'insert')).toHaveLength(0)
    })

    it('l’assenza di una collega: segreteria → 403 SOLO_LA_PROPRIA; admin → 201', async () => {
        const rifiutata = await invia({ utenteId: U2 })
        expect(rifiutata.status).toBe(403)
        expect((await rifiutata.json()).codice).toBe('SOLO_LA_PROPRIA')
        expect(scritte('crm_indisponibilita', 'insert')).toHaveLength(0)

        comeAdmin()
        expect((await invia({ utenteId: U2, scuolaId: SEDE_A })).status).toBe(201)
        expect(scrittaRiga()).toMatchObject({ utente_id: U2, creata_da: ADMIN })
    })

    it('una persona che non è della sede → 422', async () => {
        comeAdmin()
        const res = await invia({ utenteId: U_B, scuolaId: SEDE_A })
        expect(res.status).toBe(422)
        expect(scritte('crm_indisponibilita', 'insert')).toHaveLength(0)
    })

    it('una sede che non è la propria → 403; l’admin con due sedi e nessuna indicata → 400', async () => {
        expect((await invia({ scuolaId: SEDE_B })).status).toBe(403)
        comeAdmin()
        h.attive = [SEDE_A, SEDE_B]
        expect((await invia({ utenteId: null, motivo: 'chiusura' })).status).toBe(400)
        expect(scritte('crm_indisponibilita', 'insert')).toHaveLength(0)
    })

    it('la chiusura dell’admin va nella sede dichiarata', async () => {
        comeAdmin()
        await invia({ utenteId: null, motivo: 'chiusura', scuolaId: SEDE_B })
        expect(scrittaRiga().scuola_id).toBe(SEDE_B)
    })

    it.each([
        ['fine prima dell’inizio', { dal: '2026-11-18', al: '2026-11-16' }],
        ['orario di fine uguale all’inizio', { dal: '2026-11-03T09:00', al: '2026-11-03T09:00' }],
        ['motivo sconosciuto', { motivo: 'vacanza' }],
        ['data inesistente', { dal: '2026-02-30' }],
        ['data scritta male', { dal: '16/11/2026' }],
        ['data mancante', { al: undefined }],
    ])('%s → 400, e non si scrive', async (_nome, o) => {
        expect((await invia(o as Record<string, unknown>)).status).toBe(400)
        expect(scritte('crm_indisponibilita', 'insert')).toHaveLength(0)
    })

    it('un guasto del database → 500', async () => {
        h.errori = { 'crm_indisponibilita:insert': { code: '08006' } }
        expect((await invia()).status).toBe(500)
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('DELETE /api/admin/crm/indisponibilita/[id]', () => {
    const elimina = (id = AS1) => DELETE_ASS(json(`/api/admin/crm/indisponibilita/${id}`, 'DELETE'), ctx(id))

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await elimina()).status).toBe(403)
    })

    it('la propria assenza → 200', async () => {
        expect((await elimina()).status).toBe(200)
        expect(riga('crm_indisponibilita', AS1)).toBeUndefined()
    })

    it('l’assenza di una collega: segreteria → 403 e resta; admin → 200', async () => {
        const res = await elimina(AS2)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SOLO_LA_PROPRIA')
        expect(riga('crm_indisponibilita', AS2)).toBeDefined()

        comeAdmin()
        expect((await elimina(AS2)).status).toBe(200)
    })

    it('una chiusura di sede la toglie qualsiasi segretaria della sede, anche se l’ha messa un’altra', async () => {
        expect((await elimina(AS_SEDE)).status).toBe(200)
        expect(riga('crm_indisponibilita', AS_SEDE)).toBeUndefined()
    })

    it('la chiusura di un’altra sede → 403 e resta', async () => {
        expect((await elimina(AS_B)).status).toBe(403)
        expect(riga('crm_indisponibilita', AS_B)).toBeDefined()
    })

    it('che non c’è → 404; già tolta fra la lettura e la scrittura → 404', async () => {
        const res = await elimina('60000000-0000-4000-8000-0000000000ff')
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('ELEMENTO_NON_TROVATO')

        h.corsa = { tabella: 'crm_indisponibilita', fa: () => void (h.db.crm_indisponibilita = h.db.crm_indisponibilita.filter((r) => r.id !== AS1)) }
        expect((await elimina()).status).toBe(404)
    })

    it('il delete mira la sede oltre all’id', async () => {
        h.db.crm_indisponibilita.push(assenza({ scuola_id: SEDE_B }))
        await elimina()
        const [d] = scritte('crm_indisponibilita', 'delete')
        expect(d.colpite).toHaveLength(1)
        expect(d.colpite[0].scuola_id).toBe(SEDE_A)
    })
})
