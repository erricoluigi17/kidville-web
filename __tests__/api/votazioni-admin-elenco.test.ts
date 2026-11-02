import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Votazioni · `GET /api/admin/votazioni` (l'elenco della segreteria).
 *
 * Il database è il finto che APPLICA i filtri: un elenco senza `.in('scuola_id')` qui restituirebbe davvero
 * le votazioni dell'altra sede, e una lettura senza blocchi qui perderebbe davvero le righe oltre la
 * millesima (`maxRighe` riproduce il `max_rows` muto di PostgREST). Sono finti soltanto il gate di ruolo e le
 * sedi attive del cookie; `restringiSedi`, `statoVotazione` e le letture a blocchi sono quelli VERI.
 *
 * Solo dati finti: uuid inventati, nessun nome di persona.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string }>,
    scritture: [] as unknown[],
    maxRighe: undefined as number | undefined,
    tabelleLette: [] as string[],
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
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () =>
        creaFintoSupabase(h.db as DBFinto, h.tabelleLette, {
            errori: h.errori,
            scritture: h.scritture as Scrittura[],
            maxRighe: h.maxRighe,
        }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET } from '@/app/api/admin/votazioni/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const V1 = uuid('90000000', 1)
const V2 = uuid('90000000', 2)
const V3 = uuid('90000000', 3)
const V_ALTRA_SEDE = uuid('90000000', 99)

const C_1 = uuid('c1000000', 1) // «2 ANNI»
const C_2 = uuid('c1000000', 2) // «10 ANNI» — dopo «2 ANNI» solo con l'ordine numerico
const C_3 = uuid('c1000000', 3) // «1 PRIMARIA»
const C_B = uuid('c1000000', 9) // sede B

const E1 = uuid('a0000000', 1)
const E2 = uuid('a0000000', 2)
const E3 = uuid('a0000000', 3)
const CAND = uuid('a0000000', 8)

const FUTURO = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PASSATO = new Date(Date.now() - 86_400_000).toISOString()

function vot(id: string, over: Riga = {}): Riga {
    return {
        id,
        scuola_id: SEDE_A,
        titolo: 'Elezione di prova',
        scadenza: FUTURO,
        chiusa_il: null,
        rappresentante_istituto: false,
        creata_da: SEG,
        creata_il: '2026-10-01T08:00:00.000Z',
        aggiornata_da: null,
        aggiornata_il: null,
        ...over,
    }
}
const classe = (votazione_id: string, section_id: string, scuola_id = SEDE_A): Riga => ({ votazione_id, scuola_id, section_id })
const voto = (n: number, votazione_id: string, ambito: 'classe' | 'istituto', section_id: string | null, elettore_id: string, over: Riga = {}): Riga => ({
    id: uuid('f0000000', n),
    votazione_id,
    scuola_id: SEDE_A,
    ambito,
    section_id,
    elettore_id,
    candidato_id: CAND,
    votato_il: '2026-10-02T09:00:00.000Z',
    aggiornato_il: null,
    ...over,
})

const get = (q = '') => GET(new NextRequest(`http://localhost/api/admin/votazioni${q}`))
const votazioniLogate = () => h.logEvento.mock.calls.filter((c) => c[0] === 'votazioni')

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.maxRighe = undefined
    h.tabelleLette = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        votazioni: [],
        votazioni_classi: [],
        votazioni_candidati: [],
        votazioni_voti: [],
        sections: [
            { id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
            { id: C_2, scuola_id: SEDE_A, name: '10 ANNI', school_type: 'infanzia' },
            { id: C_3, scuola_id: SEDE_A, name: '1 PRIMARIA', school_type: 'primaria' },
            { id: C_B, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
        ],
        utenti_scuole: [],
    }
})

describe('GET /api/admin/votazioni', () => {
    it('docente o genitore → 403, e il database non si tocca', async () => {
        h.ruolo = 'educator'
        expect((await get()).status).toBe(403)
        h.ruolo = 'parent'
        expect((await get()).status).toBe(403)
        expect(h.tabelleLette).toEqual([])
    })

    it('la sede di un altro plesso → 403 SEDE_NON_ACCESSIBILE, non un elenco vuoto', async () => {
        h.db.votazioni = [vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        const res = await get(`?scuolaId=${SEDE_B}`)
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.tabelleLette).not.toContain('votazioni')
    })

    it('scuolaId che non è un uuid → 400', async () => {
        expect((await get('?scuolaId=non-un-uuid')).status).toBe(400)
    })

    it('nessuna votazione → 200 disponibile:true con elenco vuoto', async () => {
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ disponibile: true, votazioni: [] })
    })

    it('porta il riepilogo nella forma del contratto, con classi in ordine di nome (numerico)', async () => {
        h.db.votazioni = [vot(V1, { rappresentante_istituto: true })]
        // inserite in ordine SBAGLIATO apposta: l'ordine in uscita lo deve fare la route
        h.db.votazioni_classi = [classe(V1, C_2), classe(V1, C_3), classe(V1, C_1)]
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            disponibile: true,
            votazioni: [
                {
                    id: V1,
                    scuolaId: SEDE_A,
                    titolo: 'Elezione di prova',
                    scadenza: FUTURO,
                    chiusaIl: null,
                    stato: 'aperta',
                    rappresentanteIstituto: true,
                    classi: [
                        { sectionId: C_3, nome: '1 PRIMARIA', grado: 'primaria' },
                        { sectionId: C_1, nome: '2 ANNI', grado: 'infanzia' },
                        { sectionId: C_2, nome: '10 ANNI', grado: 'infanzia' },
                    ],
                    votanti: 0,
                    creataIl: '2026-10-01T08:00:00.000Z',
                },
            ],
        })
    })

    it('dalla più recente: l’ordine lo fa la route, non l’ordine di inserimento', async () => {
        h.db.votazioni = [
            vot(V1, { creata_il: '2026-10-01T08:00:00.000Z' }),
            vot(V3, { creata_il: '2026-10-03T08:00:00.000Z' }),
            vot(V2, { creata_il: '2026-10-02T08:00:00.000Z' }),
        ]
        const { votazioni } = await (await get()).json()
        expect(votazioni.map((v: Riga) => v.id)).toEqual([V3, V2, V1])
    })

    it('lo stato si ricava: aperta, scaduta e chiusa a mano (anche con la scadenza futura)', async () => {
        h.db.votazioni = [
            vot(V1),
            vot(V2, { scadenza: PASSATO }),
            vot(V3, { chiusa_il: '2026-10-05T08:00:00.000Z' }),
        ]
        const { votazioni } = await (await get()).json()
        const stato = Object.fromEntries(votazioni.map((v: Riga) => [v.id, v.stato]))
        expect(stato).toEqual({ [V1]: 'aperta', [V2]: 'chiusa', [V3]: 'chiusa' })
        expect(votazioni.find((v: Riga) => v.id === V3).chiusaIl).toBe('2026-10-05T08:00:00.000Z')
    })

    it('i votanti sono gli elettori DISTINTI su tutte le schede: chi vota in due schede conta una volta', async () => {
        h.db.votazioni = [vot(V1, { rappresentante_istituto: true }), vot(V2)]
        h.db.votazioni_classi = [classe(V1, C_1), classe(V1, C_2), classe(V2, C_3)]
        h.db.votazioni_voti = [
            voto(1, V1, 'classe', C_1, E1),
            voto(2, V1, 'classe', C_2, E1), // E1 vota in due classi
            voto(3, V1, 'istituto', null, E1), // …e per l’istituto
            voto(4, V1, 'classe', C_1, E2),
            voto(5, V2, 'classe', C_3, E3), // un’altra votazione: non si mescola
        ]
        const { votazioni } = await (await get()).json()
        const per = Object.fromEntries(votazioni.map((v: Riga) => [v.id, v.votanti]))
        expect(per).toEqual({ [V1]: 2, [V2]: 1 })
    })

    it('le votazioni (e i voti) dell’altra sede non escono, e ogni lettura porta il filtro di sede', async () => {
        h.db.votazioni = [vot(V1), vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        h.db.votazioni_classi = [classe(V1, C_1), classe(V_ALTRA_SEDE, C_B, SEDE_B)]
        h.db.votazioni_voti = [voto(1, V_ALTRA_SEDE, 'classe', C_B, E1, { scuola_id: SEDE_B })]
        const { votazioni } = await (await get()).json()
        expect(votazioni.map((v: Riga) => v.id)).toEqual([V1])
        expect(votazioni[0].classi.map((c: Riga) => c.sectionId)).toEqual([C_1])
        expect(votazioni[0].votanti).toBe(0)
    })

    it('la Direzione con due sedi attive le vede insieme; ?scuolaId restringe a una', async () => {
        h.ruolo = 'admin'
        h.attive = [SEDE_A, SEDE_B]
        h.db.votazioni = [vot(V1), vot(V_ALTRA_SEDE, { scuola_id: SEDE_B, creata_il: '2026-10-09T08:00:00.000Z' })]
        const tutte = await (await get()).json()
        expect(tutte.votazioni.map((v: Riga) => v.id)).toEqual([V_ALTRA_SEDE, V1])
        const solo = await (await get(`?scuolaId=${SEDE_B}`)).json()
        expect(solo.votazioni.map((v: Riga) => v.id)).toEqual([V_ALTRA_SEDE])
    })

    it('nessuna sede attiva (scope vuoto) → elenco vuoto, mai l’elenco di tutte le sedi', async () => {
        h.attive = []
        h.db.votazioni = [vot(V1), vot(V_ALTRA_SEDE, { scuola_id: SEDE_B })]
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ disponibile: true, votazioni: [] })
    })

    it('oltre le 1000 righe PostgREST taglia in silenzio: i votanti si contano a blocchi', async () => {
        h.maxRighe = 1000
        h.db.votazioni = [vot(V1)]
        h.db.votazioni_classi = [classe(V1, C_1)]
        h.db.votazioni_voti = Array.from({ length: 1500 }, (_, i) =>
            voto(i + 1, V1, 'classe', C_1, uuid('e0000000', i + 1)),
        )
        const { votazioni } = await (await get()).json()
        expect(votazioni[0].votanti).toBe(1500)
    })

    it('schema assente (PGRST205 / 42P01) → 200 disponibile:false, con una riga warn sul canale votazioni', async () => {
        for (const code of ['PGRST205', '42P01']) {
            h.logEvento.mockClear()
            h.errori = { votazioni: { code } }
            const res = await get()
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ disponibile: false, votazioni: [] })
            expect(votazioniLogate().some((c) => c[1] === 'warn')).toBe(true)
        }
    })

    it('schema assente su una tabella FIGLIA → 200 disponibile:false, non un 500', async () => {
        h.db.votazioni = [vot(V1)]
        h.errori = { votazioni_classi: { code: 'PGRST205' } }
        const res = await get()
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ disponibile: false, votazioni: [] })
    })

    it('un guasto del database → 500 VOTAZIONE_OPERAZIONE_NON_RIUSCITA, mai un elenco vuoto che sembri “nessuna votazione”', async () => {
        for (const tabella of ['votazioni', 'votazioni_classi', 'votazioni_voti', 'sections']) {
            h.db.votazioni = [vot(V1)]
            h.db.votazioni_classi = [classe(V1, C_1)]
            h.errori = { [tabella]: { code: '08006' } }
            const res = await get()
            expect(res.status, tabella).toBe(500)
            expect((await res.json()).codice, tabella).toBe('VOTAZIONE_OPERAZIONE_NON_RIUSCITA')
        }
    })

    it('è una lettura: non scrive niente e non lascia battiti di successo', async () => {
        h.db.votazioni = [vot(V1)]
        await get()
        expect(h.scritture).toEqual([])
        expect(votazioniLogate().filter((c) => c[1] === 'info')).toEqual([])
    })
})
