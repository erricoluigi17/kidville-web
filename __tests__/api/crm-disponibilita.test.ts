import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · le disponibilità per settimana e le assenze:
 * `GET/PUT /api/admin/crm/disponibilita`, `GET/POST /api/admin/crm/indisponibilita`, `DELETE /indisponibilita/[id]`.
 *
 * Come per gli appuntamenti: gate e cookie delle sedi finti, tutto il resto vero, database finto che applica
 * i filtri ed esegue le scritture. Le fasce stanno in `crm_settimane` (la testata, col lunedì) e `crm_fasce`, di
 * una persona o della sede (`utente_id` nullo): «una settimana mai toccata è uguale all'ultima registrata prima di
 * lei». Chi salva una settimana chiama la funzione SQL `crm_salva_settimana`, che qui è un MODELLO IN MEMORIA
 * (`salvaSettimanaFinta`) con le sue stesse regole: prova che la route le passi gli argomenti nella forma che
 * la funzione legge (chiavi `giorno_settimana`, `ora_inizio`…) e traduca ogni esito nella risposta giusta.
 *
 * Le regole che questi test fissano:
 *  · **ogni persona della sede cambia la sede e le colleghe** (spec §6.1): niente più `SOLO_LA_PROPRIA` per le
 *    fasce (resta per le assenze);
 *  · **la persona deve essere della sede**, controllata PRIMA della funzione (che non lo verifica);
 *  · le settimane passate non si modificano.
 * Gli orari sono di Roma; l'orologio è congelato (solo `Date`) a lunedì 2/11/2026, 08:00 a Roma.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    userId: '' as string,
    scuolaUtente: '' as string | null,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    letture: [] as string[],
    /** Eseguito PRIMA della seconda `from(tabella)` (la scrittura che segue la lettura della riga). */
    corsa: null as null | { tabella: string; fa: () => void },
    /** La funzione SQL `crm_salva_settimana`, come la risponde questo test. */
    rpc: (() => ({ data: null, error: null })) as (args: Record<string, unknown>) => { data: unknown; error: unknown },
    chiamateRpc: [] as Record<string, unknown>[],
    logEvento: vi.fn(),
    logErrore: vi.fn(),
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
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (...a: Parameters<typeof vero.logEvento>) => {
            h.logEvento(...a)
            return vero.logEvento(...a)
        },
        logErrore: (...a: Parameters<typeof vero.logErrore>) => {
            h.logErrore(...a)
            return vero.logErrore(...a)
        },
    }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const vero = creaFintoSupabase(h.db as DBFinto, h.letture, {
            errori: h.errori as Record<string, ErrorePostgrest>,
            scritture: h.scritture as Scrittura[],
            rpc: {
                crm_salva_settimana: async (args) => {
                    h.chiamateRpc.push(args)
                    return h.rpc(args)
                },
            },
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

import { GET as GET_DISP, PUT as PUT_DISP } from '@/app/api/admin/crm/disponibilita/route'
import { GET as GET_ASS, POST as POST_ASS } from '@/app/api/admin/crm/indisponibilita/route'
import { DELETE as DELETE_ASS } from '@/app/api/admin/crm/indisponibilita/[id]/route'

const U1 = '20000000-0000-4000-8000-000000000001' // l'utente sotto test: segreteria di SEDE_A
const U2 = '20000000-0000-4000-8000-000000000002' // una collega della stessa sede
const U_B = '20000000-0000-4000-8000-00000000000b' // segreteria di SEDE_B
const U_ARCH = '20000000-0000-4000-8000-0000000000aa' // segreteria di SEDE_A, archiviata
const ADMIN = '20000000-0000-4000-8000-0000000000ad' // Direzione, con A e B
const AS1 = '60000000-0000-4000-8000-000000000001' // assenza di U1
const AS2 = '60000000-0000-4000-8000-000000000002' // assenza di U2
const AS_SEDE = '60000000-0000-4000-8000-0000000000cc' // chiusura di SEDE_A
const AS_B = '60000000-0000-4000-8000-00000000000b' // chiusura di SEDE_B

/** Una riga di `data.proprietari` come la restituisce il GET (la forma di `FasceDelProprietario`). */
interface Proprietario {
    utenteId: string | null
    origine: 'registrata' | 'ereditata' | 'nessuna'
    daSettimana: string | null
    fasce: { utenteId: string | null; settimana: string; giornoSettimana: number; oraInizio: string; oraFine: string; durataSlotMin: number }[]
}

const json = (url: string, metodo: string, corpo?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
        method: metodo,
        headers: { 'content-type': 'application/json' },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const testata = (o: Riga = {}): Riga => ({
    id: 'sett-1',
    scuola_id: SEDE_A,
    utente_id: U1,
    settimana: '2026-10-05',
    aggiornata_da: null,
    aggiornata_il: '2026-10-01T00:00:00.000Z',
    creata_il: '2026-10-01T00:00:00.000Z',
    ...o,
})
const fascia = (o: Riga = {}): Riga => ({
    id: 'fas-1',
    scuola_id: SEDE_A,
    settimana_id: 'sett-1',
    giorno_settimana: 1,
    ora_inizio: '09:00:00',
    ora_fine: '13:00:00',
    durata_slot_min: 45,
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

/**
 * `crm_salva_settimana` come la intende la migrazione, in memoria: lunedì, settimana non passata (il lunedì
 * della settimana in corso è quello di Roma: con l'orologio congelato a lunedì 2/11 è il 2/11), fasce non
 * sovrapposte; poi la testata si crea o si aggiorna e le fasce si SOSTITUISCONO. Legge le fasce con le chiavi
 * di `jsonb_to_recordset` (`giorno_settimana`, `ora_inizio`, `ora_fine`, `durata_slot_min`): una route che le
 * passasse con altri nomi non salverebbe niente di leggibile.
 */
function salvaSettimanaFinta(args: Record<string, unknown>): { data: unknown; error: unknown } {
    const sede = args.p_scuola_id as string
    const utente = (args.p_utente_id ?? null) as string | null
    const settimana = args.p_settimana as string
    const fasce = args.p_fasce as Riga[]
    if (!sede || !settimana || !Array.isArray(fasce)) return { data: null, error: { code: '22023', message: 'argomenti' } }
    if (new Date(`${settimana}T12:00:00Z`).getUTCDay() !== 1) return { data: { esito: 'settimana_non_valida' }, error: null }
    if (settimana < '2026-11-02') return { data: { esito: 'settimana_passata' }, error: null }
    const sovrapposte = fasce.some(
        (a, i) =>
            fasce.some(
                (b, j) =>
                    i !== j &&
                    a.giorno_settimana === b.giorno_settimana &&
                    String(b.ora_inizio) < String(a.ora_fine) &&
                    String(a.ora_inizio) < String(b.ora_fine),
            ),
    )
    if (sovrapposte) return { data: { esito: 'fasce_sovrapposte' }, error: null }

    const testate = h.db.crm_settimane
    let t = testate.find((r) => r.scuola_id === sede && (r.utente_id ?? null) === utente && r.settimana === settimana)
    if (!t) {
        t = { id: `sett-nuova-${testate.length + 1}`, scuola_id: sede, utente_id: utente, settimana }
        testate.push(t)
    }
    t.aggiornata_da = args.p_eseguito_da
    h.db.crm_fasce = h.db.crm_fasce.filter((f) => f.settimana_id !== t.id)
    fasce.forEach((f, n) =>
        h.db.crm_fasce.push({
            id: `${t.id}-f${n}`,
            scuola_id: sede,
            settimana_id: t.id,
            giorno_settimana: f.giorno_settimana,
            ora_inizio: f.ora_inizio,
            ora_fine: f.ora_fine,
            durata_slot_min: f.durata_slot_min ?? 45,
        }),
    )
    return { data: { esito: 'ok', settimana_id: t.id }, error: null }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T07:00:00.000Z')) // lunedì 2/11, 08:00 a Roma
    h.ruolo = 'segreteria'
    h.userId = U1
    h.scuolaUtente = SEDE_A
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.letture = []
    h.corsa = null
    h.rpc = salvaSettimanaFinta
    h.chiamateRpc = []
    h.logEvento = vi.fn()
    h.logErrore = vi.fn()
    h.db = {
        utenti: [
            { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
            { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
            { id: U_ARCH, nome: 'Rita', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: '2026-09-01T00:00:00.000Z' },
            { id: ADMIN, nome: 'Dir', cognome: 'Prova', ruolo: 'admin', scuola_id: SEDE_A, archiviato_il: null },
        ],
        utenti_scuole: [
            { utente_id: ADMIN, scuola_id: SEDE_A },
            { utente_id: ADMIN, scuola_id: SEDE_B },
        ],
        // U1: dal 5/10 lunedì 9–13, dal 26/10 mercoledì 14–17 · la SEDE: dal 12/10 martedì 10–11 ·
        // U2: dal 26/10 una settimana volutamente vuota · e due testate che NON devono mai uscire:
        // quella di un'altra sede e quella di una persona che non è della sede.
        crm_settimane: [
            testata({ id: 's-u1-a', utente_id: U1, settimana: '2026-10-05' }),
            testata({ id: 's-u1-b', utente_id: U1, settimana: '2026-10-26' }),
            testata({ id: 's-sede', utente_id: null, settimana: '2026-10-12' }),
            testata({ id: 's-u2', utente_id: U2, settimana: '2026-10-26' }),
            testata({ id: 's-b', scuola_id: SEDE_B, utente_id: U_B, settimana: '2026-10-26' }),
            testata({ id: 's-fuori', utente_id: U_B, settimana: '2026-10-26' }),
        ],
        crm_fasce: [
            fascia({ id: 'f-u1-a', settimana_id: 's-u1-a', giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '13:00:00' }),
            fascia({ id: 'f-u1-b', settimana_id: 's-u1-b', giorno_settimana: 3, ora_inizio: '14:00:00', ora_fine: '17:00:00' }),
            fascia({ id: 'f-sede', settimana_id: 's-sede', giorno_settimana: 2, ora_inizio: '10:00:00', ora_fine: '11:00:00' }),
            fascia({ id: 'f-b', scuola_id: SEDE_B, settimana_id: 's-b', giorno_settimana: 4 }),
            fascia({ id: 'f-fuori', settimana_id: 's-fuori', giorno_settimana: 5 }),
            // Una riga INCOERENTE: punta a una testata di SEDE_A ma dichiara SEDE_B. Non deve mai uscire dalla
            // lettura di SEDE_A: è il filtro per sede sulla lettura delle fasce a fermarla, non la testata.
            fascia({ id: 'f-incoerente', scuola_id: SEDE_B, settimana_id: 's-u1-b', giorno_settimana: 6 }),
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
    const url = (settimana = '2026-11-04', sede = SEDE_A) => `/api/admin/crm/disponibilita?scuolaId=${sede}&settimana=${settimana}`
    const leggi = async (settimana?: string) => (await (await GET_DISP(json(url(settimana), 'GET'))).json()).data
    const di = (data: { proprietari: Proprietario[] }, utenteId: string | null) =>
        data.proprietari.find((p) => p.utenteId === utenteId)

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await GET_DISP(json(url(), 'GET'))).status).toBe(403)
    })

    it('una sede che non è la propria → 403 SEDE_NON_ACCESSIBILE, e non si legge niente', async () => {
        const res = await GET_DISP(json(url('2026-11-04', SEDE_B), 'GET'))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.letture).not.toContain('crm_settimane')
    })

    it('la sede e la settimana sono richieste, e la settimana dev’essere una data vera', async () => {
        expect((await GET_DISP(json('/api/admin/crm/disponibilita?settimana=2026-11-02', 'GET'))).status).toBe(400)
        expect((await GET_DISP(json(`/api/admin/crm/disponibilita?scuolaId=${SEDE_A}`, 'GET'))).status).toBe(400)
        expect((await GET_DISP(json(url('2026-02-30'), 'GET'))).status).toBe(400)
        expect((await GET_DISP(json(url('domani'), 'GET'))).status).toBe(400)
    })

    it('normalizza il giorno al lunedì e dà sede + persone, con origine e daSettimana', async () => {
        const data = await leggi('2026-11-04') // un mercoledì: la settimana è quella di lunedì 2/11
        expect(data.settimana).toBe('2026-11-02')
        expect(data.modificabile).toBe(true)

        // La sede per prima, poi le persone della sede (per cognome e nome): una riga ciascuna, anche vuota.
        expect(data.proprietari.map((p: { utenteId: string | null }) => p.utenteId)).toEqual([null, U1, ADMIN, U2])
        expect(data.persone.map((p: { id: string }) => p.id)).toEqual([U1, ADMIN, U2])

        expect(di(data, null)).toEqual({
            utenteId: null,
            origine: 'ereditata',
            daSettimana: '2026-10-12',
            fasce: [{ utenteId: null, settimana: '2026-11-02', giornoSettimana: 2, oraInizio: '10:00', oraFine: '11:00', durataSlotMin: 45 }],
        })
        expect(di(data, U1)).toEqual({
            utenteId: U1,
            origine: 'ereditata',
            daSettimana: '2026-10-26',
            fasce: [{ utenteId: U1, settimana: '2026-11-02', giornoSettimana: 3, oraInizio: '14:00', oraFine: '17:00', durataSlotMin: 45 }],
        })
        // Mai registrato niente: nessuna origine, nessuna fascia. Una testata vuota: ereditata, vuota.
        expect(di(data, ADMIN)).toEqual({ utenteId: ADMIN, origine: 'nessuna', daSettimana: null, fasce: [] })
        expect(di(data, U2)).toEqual({ utenteId: U2, origine: 'ereditata', daSettimana: '2026-10-26', fasce: [] })
    })

    it('un giorno qualunque vale come il suo lunedì (anche la domenica, anche il lunedì stesso)', async () => {
        const lunedi = await leggi('2026-11-02')
        expect(await leggi('2026-11-08')).toEqual(lunedi)
        expect(await leggi('2026-11-05')).toEqual(lunedi)
        expect(lunedi.settimana).toBe('2026-11-02')
    })

    it('una settimana registrata si dice «registrata» e porta le proprie fasce', async () => {
        const data = await leggi('2026-10-26')
        expect(di(data, U1)).toMatchObject({ origine: 'registrata', daSettimana: '2026-10-26' })
        expect(di(data, U1)?.fasce).toHaveLength(1)
    })

    it('la modifica di una settimana si vede da quella dopo e non da quella prima', async () => {
        const prima = await leggi('2026-10-19') // U1 eredita dal 5/10: lunedì
        const dopo = await leggi('2026-11-09') // U1 eredita dal 26/10: mercoledì
        expect(di(prima, U1)).toMatchObject({ origine: 'ereditata', daSettimana: '2026-10-05' })
        expect(di(prima, U1)?.fasce.map((f: { giornoSettimana: number }) => f.giornoSettimana)).toEqual([1])
        expect(di(dopo, U1)?.fasce.map((f: { giornoSettimana: number }) => f.giornoSettimana)).toEqual([3])
        // E prima della prima settimana registrata non c'è niente.
        expect(di(await leggi('2026-09-28'), U1)).toMatchObject({ origine: 'nessuna', daSettimana: null, fasce: [] })
    })

    it('settimana passata → modificabile false; quella in corso e le future sì', async () => {
        expect((await leggi('2026-10-26')).modificabile).toBe(false) // oggi è lunedì 2/11
        expect((await leggi('2026-10-31')).modificabile).toBe(false) // sabato della settimana scorsa
        expect((await leggi('2026-11-02')).modificabile).toBe(true)
        expect((await leggi('2026-11-08')).modificabile).toBe(true)
        expect((await leggi('2026-12-14')).modificabile).toBe(true)
    })

    it('«la settimana in corso» si decide col giorno di Roma: lunedì all’una di notte (23:30Z della domenica) è già la nuova', async () => {
        vi.setSystemTime(new Date('2026-10-25T23:30:00.000Z')) // lunedì 26/10, 00:30 a Roma
        expect((await leggi('2026-10-26')).modificabile).toBe(true)
        expect((await leggi('2026-10-19')).modificabile).toBe(false)
        vi.setSystemTime(new Date('2026-10-25T22:30:00.000Z')) // domenica 25/10, 23:30 a Roma: ancora la settimana del 19
        expect((await leggi('2026-10-19')).modificabile).toBe(true)
        expect((await leggi('2026-10-26')).modificabile).toBe(true)
    })

    it('le testate e le fasce di un’altra sede non entrano, né le righe di chi non è più della sede', async () => {
        const data = await leggi('2026-10-26')
        expect(data.proprietari.map((p: { utenteId: string | null }) => p.utenteId)).not.toContain(U_B)
        expect(JSON.stringify(data.proprietari)).not.toContain('"giornoSettimana":4')
        expect(JSON.stringify(data.proprietari)).not.toContain('"giornoSettimana":5')
        expect(JSON.stringify(data.proprietari)).not.toContain('"giornoSettimana":6') // la riga incoerente
        // …e la sede B vede le sue.
        comeAdmin()
        h.attive = [SEDE_A, SEDE_B]
        const b = (await (await GET_DISP(json(url('2026-10-26', SEDE_B), 'GET'))).json()).data
        expect(b.proprietari.find((p: { utenteId: string | null }) => p.utenteId === U_B)?.fasce).toHaveLength(1)
    })

    it('dice a chi guarda chi è (dalla sessione)', async () => {
        expect((await (await GET_DISP(json(url(), 'GET'))).json()).io).toEqual({ id: U1, ruolo: 'segreteria' })
        comeAdmin()
        expect((await (await GET_DISP(json(url(), 'GET'))).json()).io).toEqual({ id: ADMIN, ruolo: 'admin' })
    })

    it('legge le testate e poi le fasce, tutte di quella sede', async () => {
        await GET_DISP(json(url(), 'GET'))
        expect(h.letture.filter((t) => t.startsWith('crm_'))).toEqual(['crm_settimane', 'crm_fasce'])
    })

    it('un guasto di lettura → 500 (testate o fasce), mai una settimana vuota', async () => {
        for (const tabella of ['crm_settimane', 'crm_fasce']) {
            h.errori = { [`${tabella}:select`]: { code: '08006' } }
            expect((await GET_DISP(json(url(), 'GET'))).status, tabella).toBe(500)
        }
    })

    it('tabelle assenti → 503 CRM_NON_INSTALLATO', async () => {
        h.errori = { 'crm_settimane:select': { code: 'PGRST205' } }
        const res = await GET_DISP(json(url(), 'GET'))
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('PUT /api/admin/crm/disponibilita', () => {
    const fasciaCorpo = (o: Record<string, unknown> = {}) => ({ giornoSettimana: 3, oraInizio: '14:00', oraFine: '17:30', durataSlotMin: 45, ...o })
    const corpo = (o: Record<string, unknown> = {}) => ({
        scuolaId: SEDE_A,
        settimana: '2026-11-09',
        utenteId: U1,
        fasce: [fasciaCorpo()],
        ...o,
    })
    const invia = (o?: Record<string, unknown>) => PUT_DISP(json('/api/admin/crm/disponibilita', 'PUT', corpo(o)))
    const ultima = () => h.chiamateRpc[h.chiamateRpc.length - 1]

    it('docente → 403, e la funzione non parte', async () => {
        h.ruolo = 'educator'
        expect((await invia()).status).toBe(403)
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('salva la propria settimana → 200, e la funzione riceve sede, persona, lunedì, fasce nella forma che legge e chi ha salvato', async () => {
        const res = await invia()
        expect(res.status).toBe(200)
        const { data } = await res.json()
        expect(data).toMatchObject({ settimana: '2026-11-09', utenteId: U1 })
        expect(typeof data.settimanaId).toBe('string')
        expect(h.chiamateRpc).toHaveLength(1)
        expect(ultima()).toEqual({
            p_scuola_id: SEDE_A,
            p_utente_id: U1,
            p_settimana: '2026-11-09',
            // le chiavi sono quelle di `jsonb_to_recordset` nella funzione SQL, in snake_case
            p_fasce: [{ giorno_settimana: 3, ora_inizio: '14:00', ora_fine: '17:30', durata_slot_min: 45 }],
            p_eseguito_da: U1,
        })
    })

    it('la settimana in corso si può salvare', async () => {
        expect((await invia({ settimana: '2026-11-02' })).status).toBe(200)
    })

    it('una collega cambia le fasce di un’altra persona della sede → 200 (non c’è più «solo la propria»)', async () => {
        const res = await invia({ utenteId: U2 })
        expect(res.status).toBe(200)
        expect(ultima()).toMatchObject({ p_utente_id: U2, p_eseguito_da: U1 })
    })

    it('la sede (utenteId nullo) la cambia qualsiasi persona della sede', async () => {
        const res = await invia({ utenteId: null })
        expect(res.status).toBe(200)
        expect(ultima()).toMatchObject({ p_utente_id: null, p_scuola_id: SEDE_A })
        expect((await res.json()).data.utenteId).toBeNull()
    })

    it('anche l’admin: la sede dichiarata, e la persona di quella sede', async () => {
        comeAdmin()
        h.attive = [SEDE_A, SEDE_B]
        const res = await invia({ scuolaId: SEDE_B, utenteId: U_B })
        expect(res.status).toBe(200)
        expect(ultima()).toMatchObject({ p_scuola_id: SEDE_B, p_utente_id: U_B, p_eseguito_da: ADMIN })
    })

    it('persona di un’altra sede → 422 PERSONA_NON_DELLA_SEDE, controllata PRIMA della funzione', async () => {
        const res = await invia({ utenteId: U_B })
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('PERSONA_NON_DELLA_SEDE')
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('una persona archiviata, o che non esiste → 422, e la funzione non parte', async () => {
        expect((await invia({ utenteId: U_ARCH })).status).toBe(422)
        expect((await invia({ utenteId: '20000000-0000-4000-8000-0000000000ff' })).status).toBe(422)
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('per la sede non si controlla nessuna persona (e il controllo c’è quando la persona c’è)', async () => {
        await invia({ utenteId: null })
        expect(h.letture).not.toContain('utenti')
        await invia({ utenteId: U2 })
        expect(h.letture).toContain('utenti')
    })

    it('una sede che non è la propria → 403, e la funzione non parte', async () => {
        const res = await invia({ scuolaId: SEDE_B, utenteId: U_B })
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('settimana passata → 409 SETTIMANA_PASSATA, e il database non cambia', async () => {
        const prima = JSON.stringify([h.db.crm_settimane, h.db.crm_fasce])
        const res = await invia({ settimana: '2026-10-26' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('SETTIMANA_PASSATA')
        expect(JSON.stringify([h.db.crm_settimane, h.db.crm_fasce])).toBe(prima)
    })

    it('una data che non è un lunedì → 400 (la funzione risponde settimana_non_valida)', async () => {
        const res = await invia({ settimana: '2026-11-04' })
        expect(res.status).toBe(400)
    })

    it('oraFine prima di oraInizio (o uguale) → 400, e la funzione non parte', async () => {
        for (const f of [{ oraInizio: '14:00', oraFine: '09:00' }, { oraInizio: '10:00', oraFine: '10:00' }]) {
            const res = await invia({ fasce: [fasciaCorpo(), fasciaCorpo({ giornoSettimana: 4, ...f })] })
            expect(res.status).toBe(400)
            expect(JSON.stringify((await res.json()).details)).toContain('fasce.1.oraFine')
        }
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('fasce sovrapposte → 422 FASCE_SOVRAPPOSTE; due che si toccano soltanto passano', async () => {
        const sovrapposte = await invia({ fasce: [fasciaCorpo({ oraInizio: '09:00', oraFine: '11:00' }), fasciaCorpo({ oraInizio: '10:30', oraFine: '12:00' })] })
        expect(sovrapposte.status).toBe(422)
        expect((await sovrapposte.json()).codice).toBe('FASCE_SOVRAPPOSTE')

        const identiche = await invia({ fasce: [fasciaCorpo(), fasciaCorpo()] })
        expect(identiche.status).toBe(422)

        const contigue = await invia({ fasce: [fasciaCorpo({ oraInizio: '09:00', oraFine: '10:00' }), fasciaCorpo({ oraInizio: '10:00', oraFine: '11:00' })] })
        expect(contigue.status).toBe(200)
        // Lo stesso orario in due giorni diversi non è una sovrapposizione.
        const giorni = await invia({ fasce: [fasciaCorpo({ giornoSettimana: 1 }), fasciaCorpo({ giornoSettimana: 2 })] })
        expect(giorni.status).toBe(200)
    })

    it('nessuna fascia → 200: è una settimana volutamente vuota, e la funzione riceve l’elenco vuoto', async () => {
        const res = await invia({ fasce: [] })
        expect(res.status).toBe(200)
        expect(ultima().p_fasce).toEqual([])
    })

    it.each([
        ['il giorno 0', { giornoSettimana: 0 }],
        ['il giorno 8', { giornoSettimana: 8 }],
        ['un giorno con la virgola', { giornoSettimana: 2.5 }],
        ['una durata di 10 minuti', { durataSlotMin: 10 }],
        ['una durata di 241 minuti', { durataSlotMin: 241 }],
        ['una durata con la virgola', { durataSlotMin: 45.5 }],
        ['una durata mancante', { durataSlotMin: undefined }],
        ['un’ora senza lo zero', { oraInizio: '9:00' }],
        ['un’ora 24:00', { oraFine: '24:00' }],
        ['un’ora con i secondi', { oraInizio: '09:00:00' }],
    ])('%s → 400, e la funzione non parte', async (_nome, f) => {
        expect((await invia({ fasce: [fasciaCorpo(f)] })).status).toBe(400)
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('al massimo 50 fasce: 50 passano, 51 no', async () => {
        const molte = (n: number) =>
            Array.from({ length: n }, (_, i) => {
                const ora = 6 + Math.floor(i / 7)
                return fasciaCorpo({ giornoSettimana: (i % 7) + 1, oraInizio: `${String(ora).padStart(2, '0')}:00`, oraFine: `${String(ora).padStart(2, '0')}:30` })
            })
        expect((await invia({ fasce: molte(50) })).status).toBe(200)
        h.chiamateRpc = []
        expect((await invia({ fasce: molte(51) })).status).toBe(400)
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('sede, settimana, persona (anche nulla) e fasce sono tutte richieste; la settimana dev’essere una data vera', async () => {
        const senza = (chiave: string) => {
            const c = corpo() as Record<string, unknown>
            delete c[chiave]
            return c
        }
        for (const chiave of ['scuolaId', 'settimana', 'utenteId', 'fasce']) {
            const res = await PUT_DISP(json('/api/admin/crm/disponibilita', 'PUT', senza(chiave)))
            expect(res.status, chiave).toBe(400)
        }
        expect((await invia({ settimana: '2026-02-30' })).status).toBe(400)
        expect((await invia({ settimana: 'lunedì' })).status).toBe(400)
        expect((await invia({ utenteId: 'non-un-uuid' })).status).toBe(400)
        expect(h.chiamateRpc).toHaveLength(0)
    })

    it('dopo il salvataggio la settimana si legge com’è stata salvata; quella prima non cambia e quelle dopo la ereditano', async () => {
        // U2 non ha fasce reali: gli si dà il martedì 8–10 dalla settimana del 9/11.
        const res = await invia({ utenteId: U2, fasce: [fasciaCorpo({ giornoSettimana: 2, oraInizio: '08:00', oraFine: '10:00' })] })
        expect(res.status).toBe(200)
        const di = (data: { proprietari: Proprietario[] }) => data.proprietari.find((p) => p.utenteId === U2)
        const leggi = async (settimana: string) =>
            (await (await GET_DISP(json(`/api/admin/crm/disponibilita?scuolaId=${SEDE_A}&settimana=${settimana}`, 'GET'))).json()).data

        const stessa = di(await leggi('2026-11-09'))
        expect(stessa).toMatchObject({ origine: 'registrata', daSettimana: '2026-11-09' })
        expect(stessa?.fasce).toEqual([{ utenteId: U2, settimana: '2026-11-09', giornoSettimana: 2, oraInizio: '08:00', oraFine: '10:00', durataSlotMin: 45 }])

        const dopo = di(await leggi('2026-11-23'))
        expect(dopo).toMatchObject({ origine: 'ereditata', daSettimana: '2026-11-09' })
        expect(dopo?.fasce).toHaveLength(1)

        // La settimana prima (2/11) eredita ancora la testata vuota del 26/10: la modifica non la raggiunge.
        const prima = di(await leggi('2026-11-02'))
        expect(prima).toMatchObject({ origine: 'ereditata', daSettimana: '2026-10-26', fasce: [] })
    })

    it('salvare di nuovo la stessa settimana la sostituisce, non la raddoppia', async () => {
        await invia({ utenteId: U2, fasce: [fasciaCorpo({ giornoSettimana: 2 }), fasciaCorpo({ giornoSettimana: 4 })] })
        await invia({ utenteId: U2, fasce: [fasciaCorpo({ giornoSettimana: 5 })] })
        const testate = (h.db.crm_settimane as Riga[]).filter((t) => t.utente_id === U2 && t.settimana === '2026-11-09')
        expect(testate).toHaveLength(1)
        const fasce = (h.db.crm_fasce as Riga[]).filter((f) => f.settimana_id === testate[0].id)
        expect(fasce.map((f) => f.giorno_settimana)).toEqual([5])
    })

    it('registra l’esito nel log con sede e numero di fasce, e nient’altro di personale', async () => {
        await invia({ fasce: [fasciaCorpo(), fasciaCorpo({ giornoSettimana: 4 })] })
        const riga = h.logEvento.mock.calls.find((c) => c[0] === 'crm' && c[2]?.esito === 'settimana-salvata')
        expect(riga).toBeDefined()
        expect(riga?.[1]).toBe('info')
        expect(riga?.[2]).toMatchObject({ operazione: 'admin/crm/disponibilita:PUT', scuola_id: SEDE_A, n: 2 })
        expect(JSON.stringify(riga)).not.toContain('Prova')
    })

    describe('gli esiti e gli errori della funzione', () => {
        it('un esito che la route non conosce → 500 CRM_OPERAZIONE_NON_RIUSCITA, con un log di errore', async () => {
            h.rpc = () => ({ data: { esito: 'inventato' }, error: null })
            const res = await invia()
            expect(res.status).toBe(500)
            expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
            expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
        })

        it('una risposta vuota → 500, non un «salvato» finto', async () => {
            h.rpc = () => ({ data: null, error: null })
            expect((await invia()).status).toBe(500)
        })

        it('settimana_non_valida → 400', async () => {
            h.rpc = () => ({ data: { esito: 'settimana_non_valida' }, error: null })
            expect((await invia()).status).toBe(400)
        })

        it('la funzione non c’è (PGRST202, 42883) o la tabella manca (PGRST205, 42P01) → 503 CRM_NON_INSTALLATO', async () => {
            for (const code of ['PGRST202', '42883', 'PGRST205', '42P01']) {
                h.rpc = () => ({ data: null, error: { code, message: 'x' } })
                const res = await invia()
                expect(res.status, code).toBe(503)
                expect((await res.json()).codice, code).toBe('CRM_NON_INSTALLATO')
            }
        })

        it('una colonna inesistente DENTRO la funzione (42703, PGRST204) è un errore vero: 500, non «CRM non installato»', async () => {
            for (const code of ['42703', 'PGRST204']) {
                h.rpc = () => ({ data: null, error: { code, message: 'x' } })
                const res = await invia()
                expect(res.status, code).toBe(500)
                expect((await res.json()).codice, code).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
            }
        })

        it('argomenti che la funzione rifiuta (22023): 400 e un avviso nel log, non un 500 (come la route della quota)', async () => {
            h.rpc = () => ({ data: null, error: { code: '22023', message: 'sede, settimana e fasce sono obbligatori' } })
            const res = await invia()
            expect(res.status).toBe(400)
            const avviso = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'settimana-argomenti-non-validi')
            expect(avviso).toBeDefined()
            expect(avviso![0]).toBe('crm')
            expect(avviso![1]).toBe('warn')
            // Il testo del database non torna al client.
            expect(JSON.stringify(await res.json())).not.toContain('obbligatori')
            expect(h.logEvento.mock.calls.some((c) => c[2]?.esito === 'settimana-salvata')).toBe(false)
        })

        it('ogni altro guasto del database → 500', async () => {
            for (const code of ['08006', '40001']) {
                h.rpc = () => ({ data: null, error: { code, message: 'x' } })
                expect((await invia()).status, code).toBe(500)
            }
        })

        it('il guasto non scrive «settimana-salvata» nel log', async () => {
            h.rpc = () => ({ data: null, error: { code: '08006', message: 'x' } })
            await invia()
            expect(h.logEvento.mock.calls.some((c) => c[2]?.esito === 'settimana-salvata')).toBe(false)
        })
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
