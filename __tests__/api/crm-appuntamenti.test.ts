import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · `GET/POST /api/admin/crm/appuntamenti` e `PATCH /appuntamenti/[id]`.
 *
 * Il gate di ruolo e `resolveScuoleAttive` (le sedi del cookie) sono finti; `scuoleDiUtente`,
 * `restringiSedi`, `resolveScuolaScrittura` e `assertSchedaInScope` sono quelli VERI, e il database è
 * il finto che applica davvero i filtri e ESEGUE le scritture: «la sede viene dalla scheda» e «l'update
 * porta `stato = in_programma`» sono proprietà verificate sul contenuto del database, non asserite.
 *
 * L'orologio è congelato (solo `Date`) perché `oggi`, `da_chiudere` e gli slot dipendono da «adesso».
 * Tutti gli orari sono di Roma: il 25/10/2026 alle 03:00 è finita l'ora legale.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    userId: '' as string,
    scuolaUtente: '' as string | null,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    /** Se valorizzato: eseguito PRIMA che parta la seconda `from('crm_appuntamenti')` (la scrittura). */
    corsa: null as null | (() => void),
    notifica: vi.fn(),
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
vi.mock('@/lib/notifiche/triggers', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/notifiche/triggers')>()
    return { ...vero, notificaEvento: (...a: unknown[]) => h.notifica(...a) }
})
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const vero = creaFintoSupabase(h.db as DBFinto, [], {
            errori: h.errori as Record<string, ErrorePostgrest>,
            scritture: h.scritture as Scrittura[],
        })
        let letture = 0
        return new Proxy(vero, {
            get(bersaglio, prop, ricevitore) {
                if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
                return (tabella: string) => {
                    if (tabella === 'crm_appuntamenti' && ++letture === 2) h.corsa?.()
                    return bersaglio.from(tabella)
                }
            },
        })
    },
}))

import { GET, POST } from '@/app/api/admin/crm/appuntamenti/route'
import { PATCH } from '@/app/api/admin/crm/appuntamenti/[id]/route'

const U1 = '20000000-0000-4000-8000-000000000001' // l'utente sotto test: segreteria di SEDE_A
const U2 = '20000000-0000-4000-8000-000000000002' // una collega della stessa sede
const U3 = '20000000-0000-4000-8000-000000000003' // un’altra collega della stessa sede
const U_B = '20000000-0000-4000-8000-00000000000b' // segreteria di SEDE_B
const U_ARCH = '20000000-0000-4000-8000-0000000000aa' // segreteria di SEDE_A, archiviata
const ADMIN = '20000000-0000-4000-8000-0000000000ad' // Direzione, con A e B
const SCHEDA_A = '30000000-0000-4000-8000-00000000000a'
const SCHEDA_B = '30000000-0000-4000-8000-00000000000b'
const VISITA = '40000000-0000-4000-8000-000000000001'
const VISITA_B = '40000000-0000-4000-8000-000000000002'

const post = (corpo: unknown) =>
    new NextRequest('http://localhost/api/admin/crm/appuntamenti', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
    })
const patch = (corpo: unknown, id = VISITA) =>
    new NextRequest(`http://localhost/api/admin/crm/appuntamenti/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
    })
const get = (query: string) => new NextRequest(`http://localhost/api/admin/crm/appuntamenti${query}`)
const ctx = (id = VISITA) => ({ params: Promise.resolve({ id }) })

const visita = (o: Riga = {}): Riga => ({
    id: VISITA,
    scuola_id: SEDE_A,
    scheda_id: SCHEDA_A,
    inizio: '2026-11-02T08:00:00.000Z', // lunedì 2/11, 09:00 a Roma
    fine: '2026-11-02T08:45:00.000Z',
    durata_min: 45,
    assegnata_a: U2,
    fissato_da: U1,
    fissato_via: 'segreteria',
    stato: 'in_programma',
    svolto_da: null,
    segnato_da: null,
    segnato_il: null,
    creato_il: '2026-10-30T09:00:00.000Z',
    aggiornato_il: '2026-10-30T09:00:00.000Z',
    ...o,
})

const fascia = (o: Riga = {}): Riga => ({
    id: 'f-1',
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

const scritte = (tabella: string, operazione: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const eventiScritti = () => scritte('crm_eventi', 'insert').flatMap((s) => s.valori)
const riga = (tabella: string, id: string) => h.db[tabella].find((r) => r.id === id)

function oggiIl(iso: string) {
    vi.setSystemTime(new Date(iso))
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    oggiIl('2026-11-02T07:00:00.000Z') // lunedì 2/11, 08:00 a Roma
    h.ruolo = 'segreteria'
    h.userId = U1
    h.scuolaUtente = SEDE_A
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.corsa = null
    h.notifica = vi.fn().mockResolvedValue(undefined)
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
        crm_schede: [
            { id: SCHEDA_A, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' },
            { id: SCHEDA_B, scuola_id: SEDE_B, genitore_nome: 'Famiglia Prova' },
        ],
        crm_appuntamenti: [],
        crm_disponibilita: [],
        crm_indisponibilita: [],
        crm_eventi: [],
        crm_azioni: [],
    }
})

afterEach(() => {
    vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/crm/appuntamenti', () => {
    const corpo = (o: Record<string, unknown> = {}) => ({
        schedaId: SCHEDA_A,
        inizio: '2026-11-02T10:00', // lunedì 10:00 a Roma = 09:00Z
        assegnataA: U2,
        ...o,
    })

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await POST(post(corpo()))).status).toBe(403)
        expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(0)
    })

    it('fissa la visita: orario di Roma ancorato, durata 45 di default, fissato_da e fissato_via', async () => {
        const res = await POST(post(corpo()))
        expect(res.status).toBe(201)
        const [ins] = scritte('crm_appuntamenti', 'insert')
        expect(ins.valori[0]).toMatchObject({
            scuola_id: SEDE_A,
            scheda_id: SCHEDA_A,
            inizio: '2026-11-02T09:00:00.000Z',
            fine: '2026-11-02T09:45:00.000Z',
            durata_min: 45,
            assegnata_a: U2,
            fissato_da: U1,
            fissato_via: 'segreteria',
            stato: 'in_programma',
        })
        expect((await res.json()).id).toBeTruthy()
    })

    it('la durata si sceglie, e rispetta i limiti del database (15–240)', async () => {
        const res = await POST(post(corpo({ durataMin: 30 })))
        expect(res.status).toBe(201)
        expect(scritte('crm_appuntamenti', 'insert')[0].valori[0]).toMatchObject({
            fine: '2026-11-02T09:30:00.000Z',
            durata_min: 30,
        })
        expect((await POST(post(corpo({ durataMin: 10 })))).status).toBe(400)
        expect((await POST(post(corpo({ durataMin: 241 })))).status).toBe(400)
    })

    it('l’orario che l’agenda restituisce per uno slot (un istante ISO) si accetta così com’è', async () => {
        const res = await POST(post(corpo({ inizio: '2026-11-02T09:45:00.000Z' })))
        expect(res.status).toBe(201)
        expect(scritte('crm_appuntamenti', 'insert')[0].valori[0]).toMatchObject({ inizio: '2026-11-02T09:45:00.000Z' })
    })

    it('un orario senza forma → 400, e non si scrive niente', async () => {
        for (const inizio of ['domani alle 10', '2026-11-02', '2026-02-30T10:00']) {
            expect((await POST(post(corpo({ inizio })))).status).toBe(400)
        }
        expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(0)
    })

    it('domenica 25/10/2026 alle 10:00 di Roma → 09:00Z (l’ora legale è finita alle 3 di notte)', async () => {
        oggiIl('2026-10-20T07:00:00.000Z')
        const res = await POST(post(corpo({ inizio: '2026-10-25T10:00' })))
        expect(res.status).toBe(201)
        expect(scritte('crm_appuntamenti', 'insert')[0].valori[0]).toMatchObject({
            inizio: '2026-10-25T09:00:00.000Z',
            fine: '2026-10-25T09:45:00.000Z',
        })
        // …e il sabato prima, alle stesse 10:00 del muro, sono le 08:00Z.
        h.scritture = []
        await POST(post(corpo({ inizio: '2026-10-24T10:00' })))
        expect(scritte('crm_appuntamenti', 'insert')[0].valori[0]).toMatchObject({ inizio: '2026-10-24T08:00:00.000Z' })
    })

    it('POST admin con due sedi: la sede viene dalla scheda, non dal cookie', async () => {
        h.ruolo = 'admin'
        h.userId = ADMIN
        h.attive = [SEDE_A] // il selettore dice Giugliano…
        const res = await POST(post(corpo({ schedaId: SCHEDA_B, assegnataA: U_B }))) // …ma la scheda è dell’altra sede
        expect(res.status).toBe(201)
        const [ins] = scritte('crm_appuntamenti', 'insert')
        expect(ins.valori[0].scuola_id).toBe(SEDE_B)
        expect(eventiScritti()[0]).toMatchObject({ scuola_id: SEDE_B, scheda_id: SCHEDA_B })
    })

    it('una scheda di un’altra sede → 403, e non si scrive niente', async () => {
        const res = await POST(post(corpo({ schedaId: SCHEDA_B })))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(0)
    })

    it('una scheda che non esiste → 404 SCHEDA_NON_TROVATA', async () => {
        const res = await POST(post(corpo({ schedaId: '30000000-0000-4000-8000-0000000000ff' })))
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
    })

    it('POST con un’assegnataria di un’altra sede → 422 PERSONA_NON_DELLA_SEDE', async () => {
        const res = await POST(post(corpo({ assegnataA: U_B })))
        expect(res.status).toBe(422)
        expect((await res.json()).codice).toBe('PERSONA_NON_DELLA_SEDE')
        expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(0)
    })

    it('un’assegnataria archiviata → 422', async () => {
        expect((await POST(post(corpo({ assegnataA: U_ARCH })))).status).toBe(422)
    })

    it('POST: errore 23P01 → 409 SLOT_OCCUPATO, senza storico né notifica', async () => {
        h.errori = { 'crm_appuntamenti:insert': { code: '23P01', message: 'conflicting key value violates exclusion constraint' } }
        const res = await POST(post(corpo()))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('SLOT_OCCUPATO')
        expect(eventiScritti()).toHaveLength(0)
        expect(h.notifica).not.toHaveBeenCalled()
    })

    it('un altro guasto del database → 500, non un 201 finto', async () => {
        h.errori = { 'crm_appuntamenti:insert': { code: '08006' } }
        const res = await POST(post(corpo()))
        expect(res.status).toBe(500)
        expect(eventiScritti()).toHaveLength(0)
    })

    it('le tabelle del CRM assenti → 503 CRM_NON_INSTALLATO', async () => {
        h.errori = { 'crm_appuntamenti:insert': { code: 'PGRST205' } }
        const res = await POST(post(corpo()))
        expect(res.status).toBe(503)
        expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    })

    describe('fuori disponibilità: si può prenotare lo stesso, e la risposta lo dice', () => {
        beforeEach(() => {
            h.db.crm_disponibilita = [fascia({ utente_id: U2 })] // lunedì 9–13 della collega
        })

        it('dentro la fascia → 201 con fuori_disponibilita false', async () => {
            const res = await POST(post(corpo()))
            expect(res.status).toBe(201)
            expect((await res.json()).fuori_disponibilita).toBe(false)
        })

        it('POST fuori disponibilità → 201 con fuori_disponibilita true', async () => {
            const res = await POST(post(corpo({ inizio: '2026-11-02T18:00' })))
            expect(res.status).toBe(201)
            expect((await res.json()).fuori_disponibilita).toBe(true)
            expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(1)
        })

        it('una visita che sfora la fine della fascia è fuori', async () => {
            const res = await POST(post(corpo({ inizio: '2026-11-02T12:30' }))) // 12:30–13:15, la fascia finisce alle 13
            expect((await res.json()).fuori_disponibilita).toBe(true)
        })

        it('un’assenza della persona la rende fuori anche dentro la fascia', async () => {
            h.db.crm_indisponibilita = [
                { id: 'a-1', scuola_id: SEDE_A, utente_id: U2, dal: '2026-11-02T00:00:00.000Z', al: '2026-11-03T00:00:00.000Z', motivo: 'ferie' },
            ]
            expect((await (await POST(post(corpo()))).json()).fuori_disponibilita).toBe(true)
        })

        it('una chiusura di sede la rende fuori', async () => {
            h.db.crm_indisponibilita = [
                { id: 'a-2', scuola_id: SEDE_A, utente_id: null, dal: '2026-11-02T00:00:00.000Z', al: '2026-11-03T00:00:00.000Z', motivo: 'chiusura' },
            ]
            expect((await (await POST(post(corpo()))).json()).fuori_disponibilita).toBe(true)
        })

        it('l’assenza di un’ALTRA persona non conta', async () => {
            h.db.crm_indisponibilita = [
                { id: 'a-3', scuola_id: SEDE_A, utente_id: U1, dal: '2026-11-02T00:00:00.000Z', al: '2026-11-03T00:00:00.000Z', motivo: 'ferie' },
            ]
            expect((await (await POST(post(corpo()))).json()).fuori_disponibilita).toBe(false)
        })

        it('il giorno è quello di Roma: le 00:30 del lunedì (23:30Z della domenica) stanno nella fascia del lunedì', async () => {
            h.db.crm_disponibilita = [fascia({ utente_id: U2, ora_inizio: '00:00:00', ora_fine: '01:00:00' })]
            const res = await POST(post(corpo({ inizio: '2026-11-02T00:30', durataMin: 15 })))
            expect(scritte('crm_appuntamenti', 'insert')[0].valori[0].inizio).toBe('2026-11-01T23:30:00.000Z')
            expect((await res.json()).fuori_disponibilita).toBe(false)
        })

        it('un guasto nel leggere la disponibilità non diventa «dentro»: 500', async () => {
            h.errori = { 'crm_disponibilita:select': { code: '08006' } }
            const res = await POST(post(corpo()))
            expect(res.status).toBe(500)
            expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(0)
        })
    })

    describe('lo storico e la notifica', () => {
        it('scrive l’evento appuntamento_fissato sulla scheda giusta', async () => {
            const res = await POST(post(corpo()))
            const { id } = await res.json()
            expect(eventiScritti()).toHaveLength(1)
            expect(eventiScritti()[0]).toMatchObject({
                scheda_id: SCHEDA_A,
                scuola_id: SEDE_A,
                tipo: 'appuntamento_fissato',
                autore: U1,
                autore_via: 'segreteria',
            })
            expect((eventiScritti()[0].dati as Record<string, unknown>).appuntamento_id).toBe(id)
        })

        it('POST per una collega → notificaEvento chiamato, titolo senza genitore_nome', async () => {
            const res = await POST(post(corpo()))
            const { id } = await res.json()
            expect(h.notifica).toHaveBeenCalledTimes(1)
            const [, p] = h.notifica.mock.calls[0] as [unknown, Record<string, unknown>]
            expect(p).toMatchObject({
                tipo: 'crm_visita_assegnata',
                scuolaId: SEDE_A,
                utenteIds: [U2],
                destinatario: 'personale',
                link: '/admin/crm?tab=agenda',
                entitaId: id,
            })
            // Giorno e ora, NIENTE ALTRO: titolo e corpo compaiono sul telefono bloccato. L’uguaglianza esatta
            // è la prova: qualunque parola in più (un cognome, «Famiglia …») la rompe.
            expect(p.titolo).toBe('Visita assegnata a te')
            expect(p.corpo).toBe('lunedì 2 novembre, ore 10:00')
            expect(JSON.stringify(p)).not.toContain('Famiglia')
            expect(JSON.stringify(p)).not.toContain('Prova')
        })

        it('l’ora della notifica è quella di Roma anche nel giorno del cambio dell’ora legale', async () => {
            oggiIl('2026-10-20T07:00:00.000Z')
            await POST(post(corpo({ inizio: '2026-10-25T10:00' })))
            const [, p] = h.notifica.mock.calls[0] as [unknown, Record<string, unknown>]
            expect(p.corpo).toBe('domenica 25 ottobre, ore 10:00')
        })

        it('per sé stessa non si manda nessuna notifica', async () => {
            const res = await POST(post(corpo({ assegnataA: U1 })))
            expect(res.status).toBe(201)
            expect(h.notifica).not.toHaveBeenCalled()
        })

        it('una notifica che non parte non annulla la visita: resta 201', async () => {
            h.notifica = vi.fn().mockRejectedValue(new Error('push giù'))
            const res = await POST(post(corpo()))
            expect(res.status).toBe(201)
            expect(scritte('crm_appuntamenti', 'insert')).toHaveLength(1)
        })
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/admin/crm/appuntamenti/[id]', () => {
    beforeEach(() => {
        h.db.crm_appuntamenti = [visita()]
        oggiIl('2026-11-02T12:00:00.000Z') // lunedì 2/11, 13:00 a Roma: la visita delle 9 è già passata
    })

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await PATCH(patch({ azione: 'annulla' }), ctx())).status).toBe(403)
    })

    it('un’azione che non esiste → 400', async () => {
        expect((await PATCH(patch({ azione: 'cancella' }), ctx())).status).toBe(400)
        expect((await PATCH(patch({}), ctx())).status).toBe(400)
    })

    it('una visita che non c’è → 404 ELEMENTO_NON_TROVATO', async () => {
        const res = await PATCH(patch({ azione: 'annulla' }), ctx('40000000-0000-4000-8000-0000000000ff'))
        expect(res.status).toBe(404)
        expect((await res.json()).codice).toBe('ELEMENTO_NON_TROVATO')
    })

    it('una visita di un’altra sede → 403, e resta com’è', async () => {
        h.db.crm_appuntamenti = [visita({ id: VISITA_B, scuola_id: SEDE_B, scheda_id: SCHEDA_B, assegnata_a: U_B })]
        const res = await PATCH(patch({ azione: 'annulla' }, VISITA_B), ctx(VISITA_B))
        expect(res.status).toBe(403)
        expect(riga('crm_appuntamenti', VISITA_B)?.stato).toBe('in_programma')
        expect(scritte('crm_appuntamenti', 'update')).toHaveLength(0)
    })

    describe('svolto', () => {
        it('svolto fatto dalla 2 e segnato dalla 1 → svolto_da 2, segnato_da 1, follow_up_1 alla 2', async () => {
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({
                stato: 'svolto',
                svolto_da: U2,
                segnato_da: U1,
                segnato_il: '2026-11-02T12:00:00.000Z',
            })
            const [azione] = scritte('crm_azioni', 'insert')
            expect(azione.valori[0]).toMatchObject({
                scuola_id: SEDE_A,
                scheda_id: SCHEDA_A,
                tipo: 'follow_up_1',
                responsabile: U2,
                appuntamento_id: VISITA,
                // due giorni dopo la visita (lunedì 2 → mercoledì 4), alle 10:30 di Roma = 09:30Z
                scadenza: '2026-11-04T09:30:00.000Z',
            })
            expect(eventiScritti().map((e) => e.tipo)).toEqual(['appuntamento_svolto', 'azione_pianificata'])
        })

        it('chi ha svolto, se è un’altra persona, deve essere della sede → 422', async () => {
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U_B }), ctx())
            expect(res.status).toBe(422)
            expect(riga('crm_appuntamenti', VISITA)?.stato).toBe('in_programma')
            expect(scritte('crm_azioni', 'insert')).toHaveLength(0)
        })

        it('senza svoltoDa → 400', async () => {
            expect((await PATCH(patch({ azione: 'svolto' }), ctx())).status).toBe(400)
        })

        it('svolto su un appuntamento già annullato → 409 STATO_NON_AMMESSO', async () => {
            h.db.crm_appuntamenti = [visita({ stato: 'annullato' })]
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
            expect(scritte('crm_appuntamenti', 'update')).toHaveLength(0)
            expect(scritte('crm_azioni', 'insert')).toHaveLength(0)
        })

        it('una collega l’ha chiusa fra la lettura e la scrittura → 409, e nessun richiamo, nessuno storico', async () => {
            h.corsa = () => {
                h.db.crm_appuntamenti[0].stato = 'annullato'
            }
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
            // La chiusura della collega non è stata sovrascritta…
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({ stato: 'annullato', svolto_da: null, segnato_da: null })
            // …e la catena dei follow-up non è nata.
            expect(scritte('crm_azioni', 'insert')).toHaveLength(0)
            expect(eventiScritti()).toHaveLength(0)
        })

        it('una visita segnata con giorni di ritardo non fa nascere un richiamo già scaduto', async () => {
            h.db.crm_appuntamenti = [visita({ inizio: '2026-10-20T08:00:00.000Z', fine: '2026-10-20T08:45:00.000Z' })]
            await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            // oggi è lunedì 2/11: il richiamo è domani (3/11), non il 22/10.
            expect(scritte('crm_azioni', 'insert')[0].valori[0].scadenza).toBe('2026-11-03T09:30:00.000Z')
        })

        it('se il richiamo non si lascia scrivere la visita resta svolta, e la risposta lo dice', async () => {
            h.errori = { 'crm_azioni:insert': { code: '08006' } }
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            expect(res.status).toBe(200)
            expect((await res.json()).azione_id).toBeNull()
            expect(riga('crm_appuntamenti', VISITA)?.stato).toBe('svolto')
        })
    })

    describe('non presentato', () => {
        it('non_presentato → recupero domani alle 10:30, alla persona a cui era assegnata', async () => {
            const res = await PATCH(patch({ azione: 'non_presentato' }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({ stato: 'non_presentato', segnato_da: U1, svolto_da: null })
            expect(scritte('crm_azioni', 'insert')[0].valori[0]).toMatchObject({
                tipo: 'recupero',
                responsabile: U2, // l’assegnataria, non chi lo segna
                appuntamento_id: VISITA,
                scadenza: '2026-11-03T09:30:00.000Z', // martedì 3/11, 10:30 a Roma
            })
            expect(eventiScritti().map((e) => e.tipo)).toEqual(['appuntamento_non_presentato', 'azione_pianificata'])
        })

        it('il recupero di sabato 24/10 è domenica 25/10 alle 10:30 = 09:30Z, non 08:30Z (cambio dell’ora legale)', async () => {
            h.db.crm_appuntamenti = [visita({ inizio: '2026-10-24T08:00:00.000Z', fine: '2026-10-24T08:45:00.000Z' })]
            oggiIl('2026-10-24T15:00:00.000Z') // sabato 24/10, 17:00 a Roma
            await PATCH(patch({ azione: 'non_presentato' }), ctx())
            expect(scritte('crm_azioni', 'insert')[0].valori[0].scadenza).toBe('2026-10-25T09:30:00.000Z')
        })

        it('«oggi» è il giorno di Roma: all’una di notte di domenica 25 (23:30Z di sabato) il recupero è lunedì 26', async () => {
            oggiIl('2026-10-24T23:30:00.000Z') // domenica 25/10, 01:30 a Roma
            await PATCH(patch({ azione: 'non_presentato' }), ctx())
            expect(scritte('crm_azioni', 'insert')[0].valori[0].scadenza).toBe('2026-10-26T09:30:00.000Z')
        })

        it('già chiusa da una collega → 409, nessun recupero', async () => {
            h.corsa = () => {
                h.db.crm_appuntamenti[0].stato = 'svolto'
            }
            const res = await PATCH(patch({ azione: 'non_presentato' }), ctx())
            expect(res.status).toBe(409)
            expect(riga('crm_appuntamenti', VISITA)?.stato).toBe('svolto')
            expect(scritte('crm_azioni', 'insert')).toHaveLength(0)
        })
    })

    describe('annulla', () => {
        it('annulla → stato annullato ed evento', async () => {
            const res = await PATCH(patch({ azione: 'annulla' }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)?.stato).toBe('annullato')
            expect(eventiScritti().map((e) => e.tipo)).toEqual(['appuntamento_annullato'])
            expect(scritte('crm_azioni', 'insert')).toHaveLength(0)
        })

        it('l’update porta la sede e lo stato in programma', async () => {
            // La riga di un’altra sede con lo stesso id non si tocca: l’update mira `scuola_id` oltre a `id`.
            h.db.crm_appuntamenti = [visita(), visita({ scuola_id: SEDE_B, scheda_id: SCHEDA_B })]
            h.scritture = []
            await PATCH(patch({ azione: 'annulla' }), ctx())
            const [u] = scritte('crm_appuntamenti', 'update')
            expect(u.colpite).toHaveLength(1)
            expect(u.colpite[0].scuola_id).toBe(SEDE_A)
        })

        it('annullata due volte → la seconda è 409', async () => {
            expect((await PATCH(patch({ azione: 'annulla' }), ctx())).status).toBe(200)
            const res = await PATCH(patch({ azione: 'annulla' }), ctx())
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
            expect(eventiScritti()).toHaveLength(1)
        })
    })

    describe('sposta', () => {
        it('sposta → evento con prima e dopo, un solo appuntamento', async () => {
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00' }), ctx())
            expect(res.status).toBe(200)
            expect(h.db.crm_appuntamenti).toHaveLength(1)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({
                inizio: '2026-11-04T10:00:00.000Z',
                fine: '2026-11-04T10:45:00.000Z',
                durata_min: 45,
                assegnata_a: U2,
                stato: 'in_programma',
            })
            expect(eventiScritti()).toHaveLength(1)
            expect(eventiScritti()[0]).toMatchObject({ tipo: 'appuntamento_spostato', scheda_id: SCHEDA_A })
            expect(eventiScritti()[0].dati).toMatchObject({
                inizio_prima: '2026-11-02T08:00:00.000Z',
                inizio_dopo: '2026-11-04T10:00:00.000Z',
            })
            expect(h.notifica).not.toHaveBeenCalled()
        })

        it('la durata si può cambiare: la fine segue', async () => {
            await PATCH(patch({ azione: 'sposta', inizio: '2026-11-02T10:00', durataMin: 60 }), ctx())
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({
                inizio: '2026-11-02T09:00:00.000Z',
                fine: '2026-11-02T10:00:00.000Z',
                durata_min: 60,
            })
        })

        it('se la persona cambia: evento riassegnato, e la nuova persona viene avvisata (solo giorno e ora)', async () => {
            h.db.utenti.push({ id: U3, nome: 'Sara', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null })
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00', assegnataA: U3 }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)?.assegnata_a).toBe(U3)
            expect(eventiScritti().map((e) => e.tipo)).toEqual(['appuntamento_spostato', 'appuntamento_riassegnato'])
            expect(eventiScritti()[1].dati).toMatchObject({ assegnata_prima: U2, assegnata_dopo: U3 })
            expect(h.notifica).toHaveBeenCalledTimes(1)
            const [, p] = h.notifica.mock.calls[0] as [unknown, Record<string, unknown>]
            expect(p).toMatchObject({ tipo: 'crm_visita_assegnata', utenteIds: [U3], destinatario: 'personale', titolo: 'Visita assegnata a te' })
            expect(p.corpo).toBe('mercoledì 4 novembre, ore 11:00')
        })

        it('solo la persona cambia (stesso orario): riassegnato, niente «spostato» di una visita ferma', async () => {
            h.db.utenti.push({ id: U3, nome: 'Sara', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null })
            await PATCH(patch({ azione: 'sposta', inizio: '2026-11-02T08:00:00.000Z', assegnataA: U3 }), ctx())
            expect(eventiScritti().map((e) => e.tipo)).toEqual(['appuntamento_riassegnato'])
        })

        it('riassegnata a sé stessa: nessuna notifica', async () => {
            await PATCH(patch({ azione: 'sposta', inizio: '2026-11-02T08:00:00.000Z', assegnataA: U1 }), ctx())
            expect(riga('crm_appuntamenti', VISITA)?.assegnata_a).toBe(U1)
            expect(h.notifica).not.toHaveBeenCalled()
        })

        it('una nuova assegnataria di un’altra sede → 422, e la visita non si muove', async () => {
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00', assegnataA: U_B }), ctx())
            expect(res.status).toBe(422)
            expect(riga('crm_appuntamenti', VISITA)?.inizio).toBe('2026-11-02T08:00:00.000Z')
        })

        it('orario già occupato (23P01) → 409 SLOT_OCCUPATO, senza storico', async () => {
            h.errori = { 'crm_appuntamenti:update': { code: '23P01' } }
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00' }), ctx())
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('SLOT_OCCUPATO')
            expect(eventiScritti()).toHaveLength(0)
        })

        it('nessun cambiamento → 200 senza scritture né storico', async () => {
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-02T09:00' }), ctx())
            expect(res.status).toBe(200)
            expect(scritte('crm_appuntamenti', 'update')).toHaveLength(0)
            expect(eventiScritti()).toHaveLength(0)
        })

        it('spostare una visita già chiusa → 409 STATO_NON_AMMESSO', async () => {
            h.db.crm_appuntamenti = [visita({ stato: 'svolto' })]
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00' }), ctx())
            expect(res.status).toBe(409)
            expect(riga('crm_appuntamenti', VISITA)?.inizio).toBe('2026-11-02T08:00:00.000Z')
        })

        it('chiusa da una collega fra la lettura e la scrittura → 409 e nessuno storico', async () => {
            h.corsa = () => {
                h.db.crm_appuntamenti[0].stato = 'annullato'
            }
            const res = await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00' }), ctx())
            expect(res.status).toBe(409)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({ stato: 'annullato', inizio: '2026-11-02T08:00:00.000Z' })
            expect(eventiScritti()).toHaveLength(0)
        })

        it('lo spostamento di domenica 25/10 alle 10:00 è 09:00Z', async () => {
            await PATCH(patch({ azione: 'sposta', inizio: '2026-10-25T10:00' }), ctx())
            expect(riga('crm_appuntamenti', VISITA)?.inizio).toBe('2026-10-25T09:00:00.000Z')
        })
    })

    // La regola del titolare: ogni segretaria modifica e sposta le visite della propria sede, ANCHE quelle
    // delle colleghe. Qui chi preme il tasto è la 3, che la visita non l'ha fissata (la 1) né la riceve (la 2):
    // se un gate guardasse `fissato_da` o `assegnata_a` invece della sede, questi test sarebbero rossi.
    describe('una collega della stessa sede, che non ha fissato né riceve la visita', () => {
        beforeEach(() => {
            h.db.utenti.push({ id: U3, nome: 'Sara', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null })
            h.userId = U3
        })

        it('la sposta due volte: un appuntamento solo, due eventi della 3 concatenati, chi ha fissato resta la 1', async () => {
            expect((await PATCH(patch({ azione: 'sposta', inizio: '2026-11-04T11:00' }), ctx())).status).toBe(200)
            expect((await PATCH(patch({ azione: 'sposta', inizio: '2026-11-05T09:00' }), ctx())).status).toBe(200)

            expect(h.db.crm_appuntamenti).toHaveLength(1)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({
                inizio: '2026-11-05T08:00:00.000Z',
                assegnata_a: U2,
                fissato_da: U1,
                stato: 'in_programma',
            })
            const eventi = eventiScritti()
            expect(eventi.map((e) => [e.tipo, e.autore])).toEqual([
                ['appuntamento_spostato', U3],
                ['appuntamento_spostato', U3],
            ])
            expect(eventi[0].dati).toMatchObject({ inizio_prima: '2026-11-02T08:00:00.000Z', inizio_dopo: '2026-11-04T10:00:00.000Z' })
            expect(eventi[1].dati).toMatchObject({ inizio_prima: '2026-11-04T10:00:00.000Z', inizio_dopo: '2026-11-05T08:00:00.000Z' })
        })

        it('la segna svolta dalla 2: la visita va alla 2, la 3 resta solo chi l’ha segnata', async () => {
            const res = await PATCH(patch({ azione: 'svolto', svoltoDa: U2 }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)).toMatchObject({ stato: 'svolto', svolto_da: U2, segnato_da: U3, fissato_da: U1 })
        })

        it('la annulla', async () => {
            const res = await PATCH(patch({ azione: 'annulla' }), ctx())
            expect(res.status).toBe(200)
            expect(riga('crm_appuntamenti', VISITA)?.stato).toBe('annullato')
        })
    })
})

// ─────────────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/crm/appuntamenti', () => {
    const settimana = `?scuolaId=${SEDE_A}&dal=2026-11-02&al=2026-11-07`

    beforeEach(() => {
        oggiIl('2026-11-02T10:00:00.000Z') // lunedì 2/11, 11:00 a Roma
        h.db.crm_disponibilita = [fascia({ utente_id: U1, giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '11:00:00' })]
    })

    it('docente → 403', async () => {
        h.ruolo = 'educator'
        expect((await GET(get(settimana))).status).toBe(403)
    })

    it('una sede che non è la propria → 403 SEDE_NON_ACCESSIBILE', async () => {
        const res = await GET(get(`?scuolaId=${SEDE_B}&dal=2026-11-02&al=2026-11-07`))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    })

    it('la sede è richiesta, e le date devono avere senso', async () => {
        expect((await GET(get('?dal=2026-11-02&al=2026-11-07'))).status).toBe(400)
        expect((await GET(get(`?scuolaId=${SEDE_A}&dal=2026-11-07&al=2026-11-02`))).status).toBe(400)
        expect((await GET(get(`?scuolaId=${SEDE_A}&dal=2026-01-01&al=2026-12-31`))).status).toBe(400)
    })

    it('porta le visite con la famiglia, il segno «da chiudere» e l’avviso «fuori disponibilità»', async () => {
        h.db.crm_appuntamenti = [
            // lunedì 09:00, già passata e ancora in programma → da chiudere
            visita({ id: VISITA }),
            // martedì 10:00 Roma, assegnata a U2, che non ha nessuna fascia → fuori disponibilità
            visita({ id: 'v-2', inizio: '2026-11-03T09:00:00.000Z', fine: '2026-11-03T09:45:00.000Z', assegnata_a: U2 }),
            // martedì 09:00 Roma di U1, dentro la sua fascia → ok
            visita({ id: 'v-3', inizio: '2026-11-03T08:00:00.000Z', fine: '2026-11-03T08:45:00.000Z', assegnata_a: U1 }),
        ]
        const res = await GET(get(settimana))
        expect(res.status).toBe(200)
        const { appuntamenti } = await res.json()
        const per = (id: string) => appuntamenti.find((a: Riga) => a.id === id)
        expect(per(VISITA)).toMatchObject({ da_chiudere: true, scheda: { id: SCHEDA_A, genitore_nome: 'Famiglia Prova' } })
        expect(per('v-2')).toMatchObject({ da_chiudere: false, fuori_disponibilita: true })
        expect(per('v-3')).toMatchObject({ da_chiudere: false, fuori_disponibilita: false })
    })

    it('le annullate non compaiono; le svolte sì ma non sono né «da chiudere» né «fuori disponibilità»', async () => {
        h.db.crm_appuntamenti = [
            visita({ id: 'v-ann', stato: 'annullato' }),
            visita({ id: 'v-svo', stato: 'svolto', svolto_da: U2 }),
        ]
        const { appuntamenti } = await (await GET(get(settimana))).json()
        expect(appuntamenti.map((a: Riga) => a.id)).toEqual(['v-svo'])
        expect(appuntamenti[0]).toMatchObject({ da_chiudere: false, fuori_disponibilita: false })
    })

    it('le visite di un’altra sede e fuori settimana non entrano', async () => {
        h.db.crm_appuntamenti = [
            visita({ id: 'v-b', scuola_id: SEDE_B, scheda_id: SCHEDA_B }),
            visita({ id: 'v-fuori', inizio: '2026-11-09T08:00:00.000Z', fine: '2026-11-09T08:45:00.000Z' }),
            visita({ id: 'v-ok' }),
        ]
        const { appuntamenti } = await (await GET(get(settimana))).json()
        expect(appuntamenti.map((a: Riga) => a.id)).toEqual(['v-ok'])
    })

    it('gli estremi dell’intervallo sono giorni di Roma: sabato 7/11 sera c’è, domenica 8/11 no', async () => {
        h.db.crm_appuntamenti = [
            visita({ id: 'sab', inizio: '2026-11-07T22:30:00.000Z', fine: '2026-11-07T23:15:00.000Z' }), // sabato 23:30 Roma
            visita({ id: 'dom', inizio: '2026-11-07T23:30:00.000Z', fine: '2026-11-08T00:15:00.000Z' }), // domenica 00:30 Roma
        ]
        const { appuntamenti } = await (await GET(get(settimana))).json()
        expect(appuntamenti.map((a: Riga) => a.id)).toEqual(['sab'])
    })

    it('gli slot liberi escludono le visite in programma della persona, e solo quelle', async () => {
        h.db.crm_appuntamenti = [
            visita({ id: 'v-occ', inizio: '2026-11-03T08:00:00.000Z', fine: '2026-11-03T08:45:00.000Z', assegnata_a: U1 }),
            visita({ id: 'v-ann', stato: 'annullato', inizio: '2026-11-03T08:45:00.000Z', fine: '2026-11-03T09:30:00.000Z', assegnata_a: U1 }),
        ]
        const { slot } = await (await GET(get(settimana))).json()
        // Martedì 9–11 da 45: 09:00 (08:00Z, occupato) e 09:45 (08:45Z, libero: l’annullata non conta)
        expect(slot).toEqual([{ utenteId: U1, inizio: '2026-11-03T08:45:00.000Z', fine: '2026-11-03T09:30:00.000Z' }])
    })

    it('niente slot nel passato', async () => {
        oggiIl('2026-11-03T08:30:00.000Z') // martedì 09:30 Roma: lo slot delle 9:00 è già iniziato
        const { slot } = await (await GET(get(settimana))).json()
        expect(slot.map((s: { inizio: string }) => s.inizio)).toEqual(['2026-11-03T08:45:00.000Z'])
    })

    it('la disponibilità di una persona archiviata non offre slot', async () => {
        h.db.crm_disponibilita = [fascia({ utente_id: U_ARCH, giorno_settimana: 2 }), ...(h.db.crm_disponibilita as Riga[])]
        const { slot } = await (await GET(get(settimana))).json()
        expect(slot.every((s: { utenteId: string }) => s.utenteId === U1)).toBe(true)
        expect(slot.length).toBeGreaterThan(0)
    })

    it('la disponibilità di un’altra sede non entra, né le sue assenze', async () => {
        h.db.crm_disponibilita = [fascia({ id: 'f-b', scuola_id: SEDE_B, utente_id: U_B, giorno_settimana: 2 }), ...(h.db.crm_disponibilita as Riga[])]
        h.db.crm_indisponibilita = [
            { id: 'a-b', scuola_id: SEDE_B, utente_id: null, dal: '2026-11-03T00:00:00.000Z', al: '2026-11-04T00:00:00.000Z', motivo: 'chiusura' },
        ]
        const { slot } = await (await GET(get(settimana))).json()
        expect(slot.map((s: { utenteId: string }) => s.utenteId)).toEqual([U1, U1])
    })

    it('una chiusura di sede toglie gli slot di tutte', async () => {
        h.db.crm_indisponibilita = [
            { id: 'a-ch', scuola_id: SEDE_A, utente_id: null, dal: '2026-11-02T23:00:00.000Z', al: '2026-11-03T23:00:00.000Z', motivo: 'chiusura' },
        ]
        const { slot } = await (await GET(get(settimana))).json()
        expect(slot).toEqual([])
    })

    it('porta le persone della sede (e solo quelle)', async () => {
        const { persone } = await (await GET(get(settimana))).json()
        expect(persone.map((p: { id: string }) => p.id).sort()).toEqual([ADMIN, U1, U2].sort())
    })

    it('un guasto di lettura → 500, non una settimana vuota', async () => {
        h.errori = { 'crm_appuntamenti:select': { code: '08006' } }
        expect((await GET(get(settimana))).status).toBe(500)
    })

    it('le tabelle del CRM assenti → 503', async () => {
        h.errori = { 'crm_disponibilita:select': { code: 'PGRST205' } }
        expect((await GET(get(settimana))).status).toBe(503)
    })
})
